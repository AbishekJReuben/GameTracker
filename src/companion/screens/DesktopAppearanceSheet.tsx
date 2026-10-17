import { useEffect,useMemo } from 'react';
import { X } from 'lucide-react';
import type { RemoteLink } from '../links';
import { DesktopAppearanceSettings } from './DesktopAppearanceSettings';
/** Keep Control and its real video sink mounted while tuning the live desktop. */
export function DesktopAppearanceSheet({open,onClose,link}:{open:boolean;onClose:()=>void;link:RemoteLink}) {
  const connection=useMemo(()=>({
    get remoteHandshake(){return link.remoteHandshake?.()??null;},
    get remoteOverlayStatus(){return link.remoteOverlayStatus?.()??null;},
    onEvent:(callback:Parameters<RemoteLink['onEvent']>[0])=>{const off=link.onEvent(callback);return()=>{if(typeof off==='function')off();};},
  }),[link]);
  useEffect(()=>{
    if(!open)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopPropagation();event.preventDefault();onClose();}};
    document.addEventListener('keydown',escape,true);return()=>document.removeEventListener('keydown',escape,true);
  },[open,onClose]);
  if(!open)return null;
  return <aside role="dialog" aria-label="Live desktop appearance" className="absolute bottom-0 right-0 top-0 z-[70] flex w-[min(90vw,28rem)] flex-col border-l border-line bg-bg-900/95 shadow-2xl backdrop-blur" style={{touchAction:'pan-y'}} onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
    <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3"><span className="text-sm font-700">Tune the live desktop</span><button type="button" autoFocus onClick={onClose} className="btn btn-ghost h-9 w-9 p-0" aria-label="Close desktop appearance"><X className="h-4 w-4"/></button></div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3"><DesktopAppearanceSettings connection={connection}/></div>
  </aside>;
}
