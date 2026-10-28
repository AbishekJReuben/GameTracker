//! Independent bounded shared-world namespace. This deliberately does not enter
//! GameTracker's two-peer rooms or touch its encrypted persistent stores.
//!
//! Protocol 2 adds two shared-world features on top of the rider snapshots:
//! - Bike builds: each rider's customised build travels once as an opaque bounded
//!   blob (`{"t":"build","b":...}`, compressed JSON in base64). The server keeps the
//!   latest per rider, pushes it reliably to the rest of the world on change and to
//!   newcomers on join, and lists each rider's build version in the map roster so a
//!   client can ask again (`build_get`) after a dropped push.
//! - NPC traffic: one rider per area hosts the road traffic. Every half second the
//!   server elects hosts per world (riders in id order; a rider hosts unless a host
//!   is within HOST_RANGE) and tells each rider its role and, for a host, the riders
//!   it serves. Hosts send compact route-state frames (binary type 4: each rider's
//!   road edge, station, lane and speed, 16 bytes) about five times a second; the
//!   server relays the latest of each host to riders within TRAFFIC_RANGE (binary
//!   type 5, latest-only so a slow link never queues stale traffic). Receivers
//!   dead-reckon along the shared road graph, so traffic moves smoothly between
//!   frames with no interpolation delay.
use axum::{extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State}, routing::get, Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::{collections::{HashMap, HashSet}, sync::{Arc, atomic::{AtomicU32, Ordering}}, time::{Duration, Instant}};
use tokio::sync::{Mutex, mpsc, watch};

const PROTOCOL: u32 = 2;
const MAX_PEERS: usize = 64;
const MAX_WORLDS: usize = 8;
const POSES: usize = 26;
const HEADER: usize = 40;
const FRAME: usize = HEADER + POSES * 14;
const CELL: f64 = 150.0;
const INTEREST: f64 = 450.0;
const STALE: Duration = Duration::from_millis(1800);
const TEXT_LIMIT: usize = 2048;
const BUILD_LIMIT: usize = 1800;
const TRAFFIC_HEADER: usize = 6;
const TRAFFIC_AGENT: usize = 16;
const TRAFFIC_MAX: usize = 64;
const TRAFFIC_RANGE: f64 = 1200.0;
const HOST_RANGE: f64 = 700.0;
const TRAFFIC_STALE: Duration = Duration::from_millis(1500);

#[derive(Clone)]
pub struct Shared(Arc<WorldState>);
struct WorldState {
    start: Instant,
    next: AtomicU32,
    peers: Mutex<HashMap<u32, Rider>>,
}
struct Rider {
    world: String,
    display_name: String,
    map_out: Option<watch::Sender<String>>,
    out: watch::Sender<Vec<u8>>,
    frame: Option<Frame>,
    last_seen: Instant,
    last_reset: Instant,
    sent: HashMap<u32, (u32, Instant)>,
    min_clock_offset: Option<i32>,
    ping: u32,
    build: Option<String>,
    build_version: u32,
    control: mpsc::Sender<String>,
    traffic: Option<Traffic>,
    traffic_out: watch::Sender<Vec<u8>>,
    traffic_sent: HashMap<u32, u32>,
    role: Option<(bool, u32, Vec<u32>)>,
}
#[derive(Clone)]
struct Traffic {
    bytes: Vec<u8>,
    number: u32,
    received: Instant,
    stamp: u32,
}
#[derive(Clone)]
struct Frame {
    bytes: Vec<u8>,
    position: [f64; 3],
    velocity: [f64; 3],
    sequence: u32,
    epoch: u16,
    received: Instant,
    stamp: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    t: String, protocol: u32, world: String,
    #[serde(default)] display_name: Option<String>,
    #[serde(default)] capabilities: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Profile { t: String, display_name: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Build { t: String, b: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildGet { t: String, id: u32 }

fn valid_build(blob: &str) -> bool {
    !blob.is_empty() && blob.len() <= BUILD_LIMIT && blob.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'=')
}
/// Route-state traffic frame: [4, count, client clock u32] then count 16-byte riders. Edge indices and stations are
/// meaningful only against the shared road graph (the world identity guarantees it); the server bounds the shape and
/// the speed byte (quarter metres per second, at most 60 m/s).
fn valid_traffic(bytes: &[u8]) -> bool {
    if bytes.len() < TRAFFIC_HEADER || bytes[0] != 4 { return false; }
    let count = bytes[1] as usize;
    if count > TRAFFIC_MAX || bytes.len() != TRAFFIC_HEADER + count * TRAFFIC_AGENT { return false; }
    (0..count).all(|i| bytes[TRAFFIC_HEADER + i * TRAFFIC_AGENT + 8] <= 240)
}
fn build_message(id: u32, version: u32, blob: &str) -> String {
    json!({"t":"build","id":id,"v":version,"b":blob}).to_string()
}

fn clean_name(input: &str, id: u32) -> Option<String> {
    if input.len()>256 {return None;}
    // Names are plain labels, never markup or an identity/security credential.
    // Keep Unicode letters/emoji, normalize whitespace, and remove invisible
    // direction overrides/control characters that can spoof another label.
    let filtered:String=input.chars().filter_map(|c| {
        if c.is_whitespace(){Some(' ')}
        else if c.is_control() || matches!(c,'\u{00ad}'|'\u{200b}'..='\u{200f}'|'\u{202a}'..='\u{202e}'|'\u{2060}'..='\u{206f}'|'\u{feff}') {None}
        else {Some(c)}
    }).collect();
    let normalized=filtered.split_whitespace().collect::<Vec<_>>().join(" ");
    let bounded:String=normalized.chars().take(24).collect();
    Some(if bounded.trim().is_empty(){format!("Rider {id}")}else{bounded.trim().to_string()})
}

pub fn router() -> Router {
    let state = Shared(Arc::new(WorldState { start: Instant::now(), next: AtomicU32::new(1), peers: Mutex::new(HashMap::new()) }));
    tokio::spawn(tick(state.clone()));
    Router::new().route("/offroader/ws", get(upgrade))
        .route("/offroader/health", get(health)).with_state(state)
}
async fn health(State(s): State<Shared>) -> Json<serde_json::Value> {
    Json(json!({"service":"offroader","protocol":PROTOCOL,"players":s.0.peers.lock().await.len(),"capacity":MAX_PEERS,"capabilities":["map-roster-v1","bike-build-v1","traffic-v1"]}))
}
async fn upgrade(ws: WebSocketUpgrade, State(s): State<Shared>) -> impl axum::response::IntoResponse {
    ws.max_message_size(2048).max_frame_size(2048).on_upgrade(move |socket| connection(socket, s))
}
fn millis(s: &Shared) -> u32 { s.0.start.elapsed().as_millis() as u32 }
fn u16_at(b: &[u8], i: usize) -> u16 { u16::from_le_bytes([b[i], b[i+1]]) }
fn i16_at(b: &[u8], i: usize) -> i16 { i16::from_le_bytes([b[i], b[i+1]]) }
fn u32_at(b: &[u8], i: usize) -> u32 { u32::from_le_bytes(b[i..i+4].try_into().unwrap()) }
fn i32_at(b: &[u8], i: usize) -> i32 { i32::from_le_bytes(b[i..i+4].try_into().unwrap()) }
fn norm(v: [f64; 3]) -> f64 { (v[0]*v[0]+v[1]*v[1]+v[2]*v[2]).sqrt() }
fn distance(a: [f64; 3], b: [f64; 3]) -> f64 { norm([a[0]-b[0],a[1]-b[1],a[2]-b[2]]) }
fn valid_quaternion(b: &[u8], at: usize) -> bool {
    let q: f64 = (0..4).map(|i| (i16_at(b, at+i*2) as f64 / 32767.0).powi(2)).sum();
    (0.98..=1.02).contains(&q)
}
fn decode(bytes: Vec<u8>, now: Instant, stamp: u32) -> Option<Frame> {
    if bytes.len()!=FRAME || bytes[0]!=1 || bytes[1]&!7!=0 || u16_at(&bytes,38) as usize!=POSES { return None; }
    if !valid_quaternion(&bytes,24) { return None; }
    let mut position=[0.0;3];let mut velocity=[0.0;3];
    for i in 0..3 {
        position[i]=i32_at(&bytes,12+i*4) as f64/1000.0;
        velocity[i]=i16_at(&bytes,32+i*2) as f64/100.0;
        if position[i].abs()>20000.0 { return None; }
    }
    if norm(velocity)>100.0 { return None; }
    for i in 0..POSES { if !valid_quaternion(&bytes,HEADER+i*14+6) { return None; } }
    Some(Frame { sequence:u32_at(&bytes,4),epoch:u16_at(&bytes,2),position,velocity,received:now,stamp,bytes })
}
fn accepts(previous: &Frame, next: &Frame, last_reset: Instant) -> bool {
    let difference=next.sequence.wrapping_sub(previous.sequence);
    if difference==0 || difference>=0x80000000 { return false; }
    if next.epoch!=previous.epoch {
        return next.bytes[1]&2!=0 && next.epoch==previous.epoch.wrapping_add(1) && next.received.duration_since(last_reset)>=Duration::from_secs(1);
    }
    // The server owns membership, bounds and interest. It does NOT certify a
    // client-owned physics result as cheat-proof. The small position tolerance
    // absorbs scheduling/batched TCP delivery without permitting giant warps.
    let dt=next.received.duration_since(previous.received).as_secs_f64().min(2.0);
    distance(next.position,previous.position)<=3.0+100.0*dt
}
async fn connection(mut socket: WebSocket, s: Shared) {
    let deadline=tokio::time::Instant::now()+Duration::from_secs(5);
    let hello=loop {
        match tokio::time::timeout_at(deadline,socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) if text.len()<=512 => break serde_json::from_str::<Hello>(&text).ok(),
            Ok(Some(Ok(Message::Ping(_)|Message::Pong(_))))=>continue,
            _=>break None,
        }
    };
    let Some(h)=hello else { let _=socket.close().await;return; };
    if h.t!="hello" || h.protocol!=PROTOCOL || h.world.len()!=64 || !h.world.bytes().all(|c|c.is_ascii_hexdigit()) {
        let _=socket.send(Message::Text(json!({"t":"reject","reason":"world-or-protocol"}).to_string())).await;return;
    }
    let id=s.0.next.fetch_add(1,Ordering::Relaxed);
    if h.capabilities.len()>4 || h.capabilities.iter().any(|c|c.len()>32) {return;}
    let wants_roster=h.capabilities.iter().any(|c|c=="map-roster-v1");
    let Some(display_name)=clean_name(h.display_name.as_deref().unwrap_or(""),id) else{return;};
    let (out,mut latest)=watch::channel(Vec::new());
    let (map_out,mut map_latest)=watch::channel(String::new());
    let (traffic_out,mut traffic_latest)=watch::channel(Vec::new());
    let (control,mut control_in)=mpsc::channel::<String>(96);
    {
        let mut peers=s.0.peers.lock().await;
        let worlds:HashSet<_>=peers.values().map(|r|r.world.as_str()).collect();
        if peers.len()>=MAX_PEERS || (!worlds.contains(h.world.as_str()) && worlds.len()>=MAX_WORLDS) { return; }
        // Newcomers receive every current build of their world once (queued behind the welcome).
        for (&other,r) in peers.iter() {
            if r.world==h.world { if let Some(b)=&r.build { let _=control.try_send(build_message(other,r.build_version,b)); } }
        }
        peers.insert(id,Rider {world:h.world.clone(),display_name:display_name.clone(),map_out:if wants_roster{Some(map_out)}else{None},out,frame:None,last_seen:Instant::now(),last_reset:Instant::now()-Duration::from_secs(5),sent:HashMap::new(),min_clock_offset:None,ping:0,
            build:None,build_version:0,control,traffic:None,traffic_out,traffic_sent:HashMap::new(),role:None});
    }
    let welcome=json!({"t":"welcome","id":id,"protocol":PROTOCOL,"world":h.world,"server_ms":millis(&s),"hz":30,"interest_m":INTEREST,"display_name":display_name,"capabilities":if wants_roster{vec!["map-roster-v1"]}else{vec![]}});
    if socket.send(Message::Text(welcome.to_string())).await.is_err() { s.0.peers.lock().await.remove(&id);return; }
    let (mut sink,mut stream)=socket.split();
    let send=tokio::spawn(async move {
        loop {
            let message=tokio::select! {
                changed=latest.changed()=>{
                    if changed.is_err(){break;}
                    let bytes=latest.borrow_and_update().clone();
                    if bytes.is_empty(){continue;}
                    Message::Binary(bytes)
                },
                changed=map_latest.changed(), if wants_roster=>{
                    if changed.is_err(){break;}
                    let text=map_latest.borrow_and_update().clone();
                    if text.is_empty(){continue;}
                    Message::Text(text)
                },
                changed=traffic_latest.changed()=>{
                    if changed.is_err(){break;}
                    let bytes=traffic_latest.borrow_and_update().clone();
                    if bytes.is_empty(){continue;}
                    Message::Binary(bytes)
                },
                text=control_in.recv()=>{
                    match text {Some(text)=>Message::Text(text),None=>break}
                },
            };
            // One unsent latest snapshot per connection, and an explicit slow
            // consumer deadline. Never accumulate stale snapshots in a FIFO.
            if !matches!(tokio::time::timeout(Duration::from_millis(500),sink.send(message)).await,Ok(Ok(()))) { break; }
        }
    });
    let mut tokens=12.0f64;let mut refilled=Instant::now();let mut strikes=0;
    loop {
        let msg=tokio::select! {
            v=tokio::time::timeout(Duration::from_secs(8),stream.next())=>match v {Ok(Some(Ok(m)))=>m,_=>break},
            _=tokio::time::sleep(Duration::from_millis(100)), if send.is_finished()=>break,
        };
        let now=Instant::now();
        tokens=(tokens+now.duration_since(refilled).as_secs_f64()*65.0).min(12.0);refilled=now;
        if tokens<1.0 { strikes+=1;if strikes>12 {break;}continue; } tokens-=1.0;
        match msg {
            Message::Binary(bytes)=> {
                if bytes.len()==5 && bytes[0]==3 {
                    if let Some(rider)=s.0.peers.lock().await.get_mut(&id){rider.ping=u32_at(&bytes,1);}
                    continue;
                }
                if bytes.first()==Some(&4) {
                    if !valid_traffic(&bytes) {strikes+=1;if strikes>4 {break;}continue;}
                    let mut peers=s.0.peers.lock().await;
                    let Some(rider)=peers.get_mut(&id) else {break;};
                    // Only an elected host's traffic is relayed (a stale frame from a former host is dropped).
                    if rider.role.as_ref().map(|r|r.0).unwrap_or(false) {
                        let number=rider.traffic.as_ref().map(|t|t.number.wrapping_add(1)).unwrap_or(1);
                        rider.traffic=Some(Traffic{bytes,number,received:now,stamp:millis(&s)});
                    }
                    continue;
                }
                let Some(mut frame)=decode(bytes,now,millis(&s)) else {strikes+=1;if strikes>4 {break;}continue;};
                let mut peers=s.0.peers.lock().await;
                let Some(rider)=peers.get_mut(&id) else {break;};
                // Remove excess upstream delivery age using a per-connection
                // minimum monotonic-clock offset. Clock origins need not match.
                // This exposes TCP-stalled old source states instead of stamping
                // them as fresh simply because they arrived in a burst now.
                let offset=frame.stamp.wrapping_sub(u32_at(&frame.bytes,8)) as i32;
                let baseline=rider.min_clock_offset.map(|old|old.min(offset)).unwrap_or(offset);
                rider.min_clock_offset=Some(baseline);
                let excess=(offset as i64-baseline as i64).max(0) as u32;
                if excess>500 {continue;}
                frame.stamp=frame.stamp.wrapping_sub(excess);
                if let Some(prior)=&rider.frame {
                    if !accepts(prior,&frame,rider.last_reset) {strikes+=1;if strikes>4 {break;}continue;}
                    if prior.epoch!=frame.epoch {rider.last_reset=now;}
                }
                rider.last_seen=now;rider.frame=Some(frame);
            },
            Message::Text(text) if text.len()<=TEXT_LIMIT => {
                // App-level heartbeat ACK is supplied by every binary server
                // snapshot, including the empty world. No player data echoed.
                if text!="{\"t\":\"ping\"}" {
                    if let Some(profile)=serde_json::from_str::<Profile>(&text).ok().filter(|p|p.t=="profile") {
                        if let Some(name)=clean_name(&profile.display_name,id) {
                            if let Some(rider)=s.0.peers.lock().await.get_mut(&id) {
                                // Retain the newest validated value even when
                                // reliable delivery bunches edits together. The
                                // one-Hz map publisher already coalesces output.
                                rider.display_name=name;
                            }
                        } else {strikes+=1;}
                    } else if let Some(build)=serde_json::from_str::<Build>(&text).ok().filter(|b|b.t=="build"&&valid_build(&b.b)) {
                        let mut peers=s.0.peers.lock().await;
                        let Some(rider)=peers.get_mut(&id) else {break;};
                        if rider.build.as_deref()!=Some(build.b.as_str()) {
                            rider.build_version=rider.build_version.wrapping_add(1).max(1);
                            rider.build=Some(build.b.clone());
                            let world=rider.world.clone();let message=build_message(id,rider.build_version,&build.b);
                            // Reliable push to the rest of the world; a full queue drops it and the roster
                            // version lets that client ask again.
                            for (&other,r) in peers.iter() { if other!=id && r.world==world { let _=r.control.try_send(message.clone()); } }
                        }
                    } else if let Some(get)=serde_json::from_str::<BuildGet>(&text).ok().filter(|g|g.t=="build_get") {
                        let peers=s.0.peers.lock().await;
                        if let (Some(me),Some(target))=(peers.get(&id),peers.get(&get.id)) {
                            if me.world==target.world { if let Some(b)=&target.build { let _=me.control.try_send(build_message(get.id,target.build_version,b)); } }
                        }
                    } else {strikes+=1;}
                }
            },
            Message::Ping(_) | Message::Pong(_)=>{},
            Message::Close(_)=>break,
            _=>break,
        }
        if send.is_finished() || strikes>4 {break;}
    }
    s.0.peers.lock().await.remove(&id);send.abort();
}
fn cell(p:[f64;3])->(i32,i32) {((p[0]/CELL).floor() as i32,(p[2]/CELL).floor() as i32)}
async fn tick(s: Shared) {
    let mut timer=tokio::time::interval(Duration::from_micros(33333));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut next_roster=Instant::now();
    let mut next_roles=Instant::now();
    loop {
        timer.tick().await;let now=Instant::now();let stamp=millis(&s);
        let mut peers=s.0.peers.lock().await;
        let active:HashMap<u32,(String,Frame)>=peers.iter().filter_map(|(&id,r)| {
            r.frame.as_ref().filter(|_|now.duration_since(r.last_seen)<STALE).map(|f|(id,(r.world.clone(),f.clone())))
        }).collect();
        if now>=next_roles {
            next_roles=now+Duration::from_millis(500);
            // Traffic hosts per world: riders in id order host unless an elected host is within HOST_RANGE; each
            // rider is served by the nearest host in range. A host is told whom it serves (it spawns around them).
            let mut assignment:HashMap<u32,u32>=HashMap::new();
            let worlds:HashSet<String>=active.values().map(|v|v.0.clone()).collect();
            for world in worlds {
                let mut ids:Vec<u32>=active.iter().filter(|(_,v)|v.0==world).map(|(&id,_)|id).collect();
                ids.sort_unstable();
                let mut hosts:Vec<(u32,[f64;3])>=Vec::new();
                for id in &ids {
                    let p=active[id].1.position;
                    if !hosts.iter().any(|(_,hp)|distance(*hp,p)<HOST_RANGE) {hosts.push((*id,p));}
                }
                for id in &ids {
                    let p=active[id].1.position;
                    let best=hosts.iter().min_by(|a,b|distance(a.1,p).partial_cmp(&distance(b.1,p)).unwrap_or(std::cmp::Ordering::Equal)).map(|h|h.0).unwrap_or(*id);
                    assignment.insert(*id,best);
                }
            }
            let mut serves:HashMap<u32,Vec<u32>>=HashMap::new();
            for (&id,&host) in &assignment { if id!=host { serves.entry(host).or_default().push(id); } }
            for (&id,rider) in peers.iter_mut() {
                let Some(&host)=assignment.get(&id) else {continue;};
                let mut served=serves.get(&id).cloned().unwrap_or_default();served.sort_unstable();
                let role=(host==id,host,served);
                if rider.role.as_ref()!=Some(&role) {
                    let message=json!({"t":"traffic","host":role.0,"by":role.1,"serve":role.2}).to_string();
                    if rider.control.try_send(message).is_ok() {
                        if !role.0 {rider.traffic=None;}
                        rider.role=Some(role);
                    }
                }
            }
        }
        // Latest traffic of each active host (relayed below to riders in range).
        let hosts:Vec<(u32,String,[f64;3],Traffic)>=peers.iter().filter_map(|(&id,r)| {
            let t=r.traffic.as_ref()?;
            if now.duration_since(t.received)>=TRAFFIC_STALE || !r.role.as_ref().map(|x|x.0).unwrap_or(false) {return None;}
            let (world,frame)=active.get(&id)?;
            Some((id,world.clone(),frame.position,t.clone()))
        }).collect();
        if now>=next_roster {
            next_roster=now+Duration::from_secs(1);
            // Global map presence is deliberately separate from high-rate near
            // interest. Generate one bounded label/pose list per subscribed world,
            // never remote render rigs or native bodies for these far entries.
            let subscribed:HashSet<_>=peers.values().filter(|r|r.map_out.is_some()).map(|r|r.world.clone()).collect();
            for world in subscribed {
                let mut ids:Vec<u32>=active.iter().filter(|(_,v)|v.0==world).map(|(&id,_)|id).collect();
                ids.sort_unstable();
                let entries:Vec<_>=ids.iter().map(|id| {
                    let frame=&active[id].1;
                    let quantize=|v:[f64;3]|v.map(|x|(x*10.0).round()/10.0);
                    json!({"id":id,"name":peers[id].display_name,"p":quantize(frame.position),"v":quantize(frame.velocity),"age_ms":stamp.wrapping_sub(frame.stamp).min(2000),"bv":peers[id].build_version})
                }).collect();
                let message=json!({"t":"world_roster","world":world,"server_ms":stamp,"players":entries}).to_string();
                for rider in peers.values().filter(|r|r.world==world) {
                    if let Some(out)=&rider.map_out {out.send_replace(message.clone());}
                }
            }
        }
        let mut grid:HashMap<(String,i32,i32),Vec<u32>>=HashMap::new();
        for (&id,(world,f)) in &active {let (x,z)=cell(f.position);grid.entry((world.clone(),x,z)).or_default().push(id);}
        for (&id,rider) in peers.iter_mut() {
            let mut roster=Vec::new();let mut rows=Vec::new();
            if let Some((world,local))=active.get(&id) {
                let (x,z)=cell(local.position);
                for dx in -4..=4 { for dz in -4..=4 {
                    if let Some(ids)=grid.get(&(world.clone(),x+dx,z+dz)) {for &other in ids {
                        if other==id {continue;}let f=&active[&other].1;
                        let d=distance(f.position,local.position);
                        let relative=[f.velocity[0]-local.velocity[0],f.velocity[1]-local.velocity[1],f.velocity[2]-local.velocity[2]];
                        // Arrival margin only expands interest; camera occlusion
                        // has no role in network or physics membership.
                        if d>INTEREST+norm(relative)*0.5 {continue;}
                        roster.push(other);
                        let period=if d<100.0 {0.0} else if d<240.0 {0.09} else {0.30};
                        let should=rider.sent.get(&other).map(|(seq,t)|*seq!=f.sequence && now.duration_since(*t).as_secs_f64()>=period).unwrap_or(true);
                        if should {rows.push((other,f));rider.sent.insert(other,(f.sequence,now));}
                    }}
                }}
            }
            roster.sort_unstable();rider.sent.retain(|id,_|roster.binary_search(id).is_ok());
            let mut data=Vec::with_capacity(13+roster.len()*4+rows.len()*(FRAME+10));
            data.push(2);data.extend_from_slice(&stamp.to_le_bytes());
            data.extend_from_slice(&rider.ping.to_le_bytes());
            data.extend_from_slice(&(roster.len() as u16).to_le_bytes());
            for id in &roster {data.extend_from_slice(&id.to_le_bytes());}
            data.extend_from_slice(&(rows.len() as u16).to_le_bytes());
            for (id,f) in rows {data.extend_from_slice(&id.to_le_bytes());data.extend_from_slice(&f.stamp.to_le_bytes());data.extend_from_slice(&(f.bytes.len() as u16).to_le_bytes());data.extend_from_slice(&f.bytes);}
            rider.out.send_replace(data);
            // Traffic: each new host frame once, for hosts within range of this rider.
            if let Some((world,local))=active.get(&id) {
                let mut parts:Vec<&(u32,String,[f64;3],Traffic)>=Vec::new();
                let mut in_range:Vec<u32>=Vec::new();
                for host in &hosts {
                    if host.0==id || &host.1!=world || distance(host.2,local.position)>TRAFFIC_RANGE {continue;}
                    in_range.push(host.0);
                    if rider.traffic_sent.get(&host.0)!=Some(&host.3.number) {parts.push(host);}
                }
                rider.traffic_sent.retain(|h,_|in_range.contains(h));
                if !parts.is_empty() {
                    let mut data=Vec::with_capacity(6+parts.iter().map(|p|8+p.3.bytes.len()).sum::<usize>());
                    data.push(5);data.extend_from_slice(&stamp.to_le_bytes());data.push(parts.len() as u8);
                    for host in parts {
                        data.extend_from_slice(&host.0.to_le_bytes());
                        data.extend_from_slice(&(stamp.wrapping_sub(host.3.stamp).min(2000) as u16).to_le_bytes());
                        data.extend_from_slice(&(host.3.bytes.len() as u16).to_le_bytes());
                        data.extend_from_slice(&host.3.bytes);
                        rider.traffic_sent.insert(host.0,host.3.number);
                    }
                    rider.traffic_out.send_replace(data);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet()->Vec<u8>{let mut b=vec![0;FRAME];b[0]=1;b[30..32].copy_from_slice(&32767i16.to_le_bytes());b[38..40].copy_from_slice(&(POSES as u16).to_le_bytes());for n in 0..POSES{let i=HEADER+n*14+12;b[i..i+2].copy_from_slice(&32767i16.to_le_bytes());}b}
    #[test]fn wire_validation(){let t=Instant::now();let b=packet();assert!(decode(b.clone(),t,0).is_some());assert!(decode(b[..b.len()-1].to_vec(),t,0).is_none());let mut malformed=b.clone();malformed[30..32].fill(0);assert!(decode(malformed,t,0).is_none());let mut too_fast=b;too_fast[32..34].copy_from_slice(&20000i16.to_le_bytes());assert!(decode(too_fast,t,0).is_none());}
    #[test]fn movement_and_reset(){let t=Instant::now();let a=decode(packet(),t,0).unwrap();let mut b=a.clone();b.sequence=1;b.received=t+Duration::from_millis(33);b.position[0]=2.0;assert!(accepts(&a,&b,t));b.position[0]=1000.0;assert!(!accepts(&a,&b,t));b.epoch=1;b.bytes[1]=2;assert!(!accepts(&a,&b,t));assert!(accepts(&a,&b,t-Duration::from_secs(3)));}
    #[test]fn build_and_traffic_validation(){
        assert!(valid_build("eJzLSM3JyVcozy/KSQEAGgQEXQ=="));
        assert!(!valid_build(""));assert!(!valid_build("abc{}"));assert!(!valid_build(&"A".repeat(BUILD_LIMIT+1)));
        let mut frame=vec![0u8;TRAFFIC_HEADER+2*TRAFFIC_AGENT];frame[0]=4;frame[1]=2;
        assert!(valid_traffic(&frame));
        frame[TRAFFIC_HEADER+8]=241;assert!(!valid_traffic(&frame));frame[TRAFFIC_HEADER+8]=40;
        assert!(!valid_traffic(&frame[..frame.len()-1]));
        let mut too_many=vec![0u8;TRAFFIC_HEADER+65*TRAFFIC_AGENT];too_many[0]=4;too_many[1]=65;assert!(!valid_traffic(&too_many));
        frame[0]=1;assert!(!valid_traffic(&frame));
    }
    #[test]fn display_name_validation(){
        assert_eq!(clean_name("  A\n  B\u{202e}\u{200b}  ",3).unwrap(),"A B");
        assert_eq!(clean_name("",3).unwrap(),"Rider 3");
        assert_eq!(clean_name(&"🚲".repeat(30),3).unwrap().chars().count(),24);
        assert!(clean_name(&"x".repeat(257),3).is_none());
        assert_eq!(clean_name("தமிழ் Rider 🚲",3).unwrap(),"தமிழ் Rider 🚲");
    }
}
