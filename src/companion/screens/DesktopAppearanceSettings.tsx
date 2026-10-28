import { useEffect,useState } from 'react';
import { Palette,RotateCcw } from 'lucide-react';
import type { CloudConn } from '../cloud';
import { APPEARANCE_RANGES,changeAppearance,readAppearance,resetAppearanceGroup,saveAppearance,selectAppearancePreset,type AppearanceDocument,type DesktopAppearance } from '../remotePreferences';
import { DesktopAppearancePreview } from './DesktopAppearancePreview';
type Connection=Pick<CloudConn,'remoteHandshake'|'remoteOverlayStatus'|'onEvent'>;
const groups:{key:keyof DesktopAppearance;label:string;fields:[string,string,string?][]}[]=[
  {key:'border',label:'Border',fields:[['thickness','Thickness','px'],['opacity','Opacity','%'],['glow','Glow strength','%'],['fade','Inward fade','px'],['cornerSoftness','Corner softness','px']]},
  {key:'aurora',label:'Aurora',fields:[['speed','Motion speed','%'],['ribbons','Ribbon strength','%'],['softness','Softness','%'],['reaction','Movement reaction','%']]},
  {key:'palette',label:'Palette',fields:[['primary','Primary color'],['secondary','Secondary color'],['accent','Accent color']]},
  {key:'tint',label:'Tint',fields:[['strength','Strength','%'],['reach','Inward reach','px']]},
  {key:'halo',label:'Cursor halo',fields:[['enabled','Enabled'],['radius','Radius','px'],['opacity','Opacity','%'],['softness','Softness','%'],['response','Movement response','%']]},
  {key:'ripples',label:'Click ripples',fields:[['enabled','Enabled'],['size','Size','px'],['strength','Strength','%'],['thickness','Thickness','px'],['duration','Duration','s']]},
  {key:'lens',label:'Viewing area',fields:[['enabled','Enabled'],['strength','Strength','%'],['resting','Resting level','%']]},
  {key:'label',label:'Identity label',fields:[['size','Size','px'],['placement','Placement'],['backing','Backing opacity','%'],['announcementSeconds','Announcement duration','s']]},
];
export function DesktopAppearanceSettings({connection}:{connection?:Connection|null}) {
  const [doc,setDoc]=useState(readAppearance),[,refresh]=useState(0);
  useEffect(()=>connection?.onEvent(e=>{if(e.event==='remote-capabilities'||e.event==='remote-overlay-status')refresh(n=>n+1);}),[connection]);
  const commit=(next:AppearanceDocument)=>{setDoc(next);saveAppearance(next);};
  const edit=(group:keyof DesktopAppearance,key:string,value:unknown)=>{
    const next=structuredClone(doc.value) as unknown as Record<string,unknown>;
    if(key)(next[group] as Record<string,unknown>)[key]=value;else next[group]=value;
    commit(changeAppearance(doc,next as unknown as DesktopAppearance));
  };
  const range=(group:keyof DesktopAppearance,key:string,label:string,unit='')=>{
    const path=key?`${group}.${key}`:group,[min,max]=APPEARANCE_RANGES[path];
    const value=key?(doc.value[group] as unknown as Record<string,number>)[key]:doc.value[group] as number;
    const step=unit==='px'?(key==='thickness'?.25:1):unit==='s'?.05:unit==='%'?.001:.01;
    return <label className="block space-y-1 text-xs" key={path}><span className="flex justify-between gap-3"><span>{label}</span><output className="tabular-nums text-ink-dim">{unit==='%'?Number((value*100).toFixed(1)):Number(value.toFixed(2))}{unit}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e=>edit(group,key,Number(e.target.value))} className="w-full accent-violet-400" aria-label={label}/></label>;
  };
  const status=connection?.remoteOverlayStatus,handshake=connection?.remoteHandshake;
  const statusText=!connection?'Connect to a PC to apply these saved settings.':!handshake?.capabilities.includes('desktop-appearance-v1')?'This host needs updating to show desktop decoration.':status?.degraded||status?.available===false?`Desktop decoration is unavailable${Object.keys(status.failedDisplays).length?' on one or more displays':''}. Remote control remains available.`:status?.activeDisplayIds.length?'The desktop indicator is active on the viewed displays.':'Saved for this client. Open Control to show the desktop indicator.';
  return <section className="space-y-4 rounded-2xl border border-line bg-bg-900/60 p-4">
    <div className="flex items-center gap-2"><Palette className="h-4 w-4 text-accent"/><h2 className="font-700">Desktop appearance</h2><span className="ml-auto text-xs text-ink-dim">{doc.preset}</span></div>
    <p role="status" aria-label="Desktop indicator status" className="text-xs text-ink-dim">{statusText}</p>
    {status&&Object.keys(status.failedDisplays).length>0&&<ul className="space-y-1 text-xs text-ink-dim">{Object.keys(status.failedDisplays).map(id=><li key={id}>{handshake?.layout.displays.find(d=>d.id===id)?.name??'Display'}: desktop decoration unavailable.</li>)}</ul>}
    <div className="flex flex-wrap gap-2">{(['Subtle','Balanced','Expressive'] as const).map(p=><button key={p} type="button" aria-pressed={doc.preset===p} className={`btn h-9 px-3 text-xs ${doc.preset===p?'btn-primary':'btn-subtle'}`} onClick={()=>commit(selectAppearancePreset(doc,p))}>{p}</button>)}
      {doc.lastCustom&&<button type="button" className="btn btn-subtle h-9 px-3 text-xs" aria-pressed={doc.preset==='Custom'} onClick={()=>commit(selectAppearancePreset(doc,'Custom'))}>Restore custom</button>}</div>
    {range('intensity','','Overall intensity','%')}{range('aurora','speed','Motion speed','%')}
    <DesktopAppearancePreview appearance={doc.value}/>
    <details className="space-y-3"><summary className="cursor-pointer py-2 text-sm font-600">Individual controls</summary>
      {groups.map(group=><fieldset key={group.key} className="space-y-3 rounded-xl border border-line p-3"><legend className="px-1 text-sm font-600">{group.label}</legend>
        {group.fields.map(([key,label,unit])=>group.key==='palette'?<label key={key} className="flex items-center justify-between gap-3 text-xs">{label}<input type="color" aria-label={label} value={(doc.value.palette as unknown as Record<string,string>)[key]} onChange={e=>edit('palette',key,e.target.value)} className="h-9 w-14 rounded bg-transparent"/></label>
          :key==='enabled'?<label key={key} className="flex items-center justify-between text-xs">{group.label} enabled<input type="checkbox" aria-label={`${group.label} enabled`} checked={(doc.value[group.key] as {enabled:boolean}).enabled} onChange={e=>edit(group.key,key,e.target.checked)} className="h-5 w-5 accent-violet-400"/></label>
          :key==='placement'?<label key={key} className="flex items-center justify-between text-xs">{label}<select aria-label="Label placement" className="input h-9" value={doc.value.label.placement} onChange={e=>edit('label','placement',e.target.value)}><option value="topCenter">Top center</option><option value="topLeft">Top left</option><option value="topRight">Top right</option></select></label>:range(group.key,key,label,unit))}
        <button type="button" className="text-xs text-ink-dim underline" onClick={()=>commit(resetAppearanceGroup(doc,group.key))}>Reset {group.label.toLowerCase()}</button>
        {group.key==='label'&&<p className="text-[11px] text-ink-faint">Announcement duration applies to the next arrival.</p>}
        {group.key==='lens'&&<p className="text-[11px] text-ink-faint">While you zoom in, the PC traces the area on your screen and the identity label moves onto it. Resting level is how strong it stays once the view stops moving.</p>}
      </fieldset>)}
      <fieldset className="space-y-2 rounded-xl border border-line p-3"><legend className="px-1 text-sm font-600">Motion comfort</legend>
        <label className="flex items-center justify-between gap-2 text-xs">Motion<select className="input h-9" aria-label="Motion comfort" value={doc.value.motion} onChange={e=>edit('motion','',e.target.value)}><option value="system">Follow system preference</option><option value="reduce">Reduce motion</option></select></label>
        <p className="text-[11px] text-ink-faint">Follow system uses the PC’s animation preference.</p>
        <button type="button" className="text-xs text-ink-dim underline" onClick={()=>commit(resetAppearanceGroup(doc,'motion'))}>Reset motion comfort</button>
      </fieldset>
    </details>
    <button type="button" className="btn btn-subtle h-10 w-full gap-2 text-xs" onClick={()=>commit(selectAppearancePreset(doc,'Subtle'))}><RotateCcw className="h-3.5 w-3.5"/>Reset appearance</button>
    <p className="text-[11px] text-ink-faint">Only desktop appearance changes. Your stream quality, controls and saved connections keep their settings.</p>
  </section>;
}
