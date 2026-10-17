import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { normalizeControllerName, readControllerName, saveControllerName } from '../remotePreferences';
export function RemoteIdentitySettings() {
  const [name,setName]=useState(readControllerName);
  return <section className="rounded-2xl border border-line bg-bg-900/60 p-4">
    <div className="mb-3 flex items-center gap-2"><UserRound className="h-4 w-4 text-accent"/><h2 className="font-700">Remote identity</h2></div>
    <label className="block text-sm text-ink-soft" htmlFor="remote-controller-name">Controller name</label>
    <input id="remote-controller-name" className="input mt-2 h-11 w-full" value={name} maxLength={192} placeholder="Remote User" autoComplete="nickname"
      onChange={e=>{setName(e.target.value);saveControllerName(e.target.value);}}
      onBlur={()=>{const clean=normalizeControllerName(name);setName(clean);saveControllerName(clean);}} />
    <p className="mt-2 text-[12px] text-ink-dim">Shown on the PC as “Controlled remotely by {normalizeControllerName(name)}”. Your device approval stays separate.</p>
  </section>;
}
