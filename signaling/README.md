# GameTracker signaling server

A tiny WebSocket **rendezvous** server. It's the one piece of always-on infrastructure
that lets the phone reach your PC **from anywhere with nothing to install** — the same
role Tailscale's coordination server plays.

It does **not** carry your screen or control traffic. It only brokers the WebRTC
handshake: the PC and phone each connect with the same short **connection code**, and
the server relays their SDP offer/answer + ICE candidates. Once WebRTC punches a direct
peer-to-peer path, this server goes idle. Traffic through it is a few kilobytes per
session, so it runs comfortably on the smallest free tier.

## What it costs

- Direct P2P works on most home/office networks → traffic is peer-to-peer, this server
  only sees the handshake. Effectively free.
- For networks where direct P2P fails (symmetric NAT, some cellular/CGNAT), you also need
  a **TURN** relay (that one does carry traffic and costs bandwidth). See "TURN" below.
  You can ship without TURN first — it just means a minority of networks won't connect.

## Deploy

### Cloudflare Tunnel on your own PC (the setup GameTracker ships with)

The signaling URL **baked into the app** is `wss://discovery.chilloutgamestudio.com`, served by
running this server locally and exposing it with a Cloudflare Tunnel. Because it's baked in, the
phone only needs the **connection code** — nothing to paste.

1. **Run the signaling server** on this PC (keep it running):
   ```sh
   npm run signal:serve        # builds + runs on localhost:8080
   # or: npm run signal:run
   ```
2. **Expose it via Cloudflare Tunnel** → `discovery.chilloutgamestudio.com` → `http://localhost:8080`.
   If you already run `cloudflared`, just add the hostname rule to your `config.yml` `ingress:` list
   and restart. Otherwise see `cloudflared-config.example.yml` here for the full first-time steps
   (`cloudflared tunnel login/create/route dns/run`). WebSockets pass through automatically.
3. In GameTracker → **Remote**, turn on **cloud access**. The signaling address is already filled in;
   share the **connection code** with the phone. Screen + control then run **directly peer-to-peer**.

To use a different domain, change `DEFAULT_SIGNAL_URL` in `src/lib/remoteConfig.ts` **and** the
`remote_signal_url` default in `src-tauri/src/db/settings.rs`, then rebuild.

### Alternatives (if you'd rather not self-host)

- **Fly.io** (free allowance): `cd signaling && fly launch --copy-config --now` → your URL is
  `wss://<app-name>.fly.dev`. Enter it in Remote → cloud settings (Advanced).
- **Docker / any VPS**: `docker build -t gt-signal . && docker run -d -p 8080:8080
  --restart unless-stopped gt-signal`, fronted by a TLS reverse proxy (Caddy/nginx) for `wss://`.
- **Railway / Render**: point the platform at this folder (autodetects the Dockerfile), expose `$PORT`.

## Endpoints
- `GET /health` → `ok`
- `GET /ws?room=<CODE>&role=<host|guest>` → the signaling WebSocket (relays to the
  other member of the room; rooms are capped at 2 peers).

## TURN (optional, for the hard networks)
WebRTC needs a TURN server to relay when a direct connection can't be established. Easiest
options: a managed TURN (Cloudflare Calls TURN, Metered, Twilio) or self-host `coturn`.
Put its URL + credentials in GameTracker → Remote → Cloud settings; they're passed to the
browser/PC as ICE servers. Without TURN, connections still succeed on most networks via
STUN hole-punching (a free public STUN server is used by default).
