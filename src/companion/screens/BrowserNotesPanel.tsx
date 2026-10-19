import {useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,Copy,Download,Image as ImageIcon,Loader2,NotebookPen,Search,X} from 'lucide-react';
import {useCompanionClip} from '../clipboardCompanion';
import {copyBrowserImage,copyBrowserText} from '../browserClipboard';
import {relativeTime} from '@/lib/format';
import type {ClipItem} from '@/lib/clip';

/** Opens the existing encrypted Notes feed only while this panel is visible. */
export default function BrowserNotesPanel({onClose}:{onClose:()=>void}){
  const notes=useCompanionClip();
  const [search,setSearch]=useState(''),[limit,setLimit]=useState(24);
  const [copied,setCopied]=useState(''),[error,setError]=useState(''),[manual,setManual]=useState('');
  const [loading,setLoading]=useState('');
  const dialog=useRef<HTMLElement|null>(null),closeRef=useRef(onClose);
  const revision=useRef(0),copiedTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const mounted=useRef(true);
  closeRef.current=onClose;
  useEffect(()=>{
    let alive=true;mounted.current=true;const previous=document.activeElement as HTMLElement|null;
    const sync=()=>{if(document.visibilityState==='hidden')notes.stop();else void notes.init().catch(()=>{if(alive)setError('Notes could not connect. Close the panel and try again.');});};
    sync();dialog.current?.focus({preventScroll:true});document.addEventListener('visibilitychange',sync);
    return()=>{alive=false;mounted.current=false;revision.current++;if(copiedTimer.current)clearTimeout(copiedTimer.current);document.removeEventListener('visibilitychange',sync);notes.stop();if(previous?.isConnected)previous.focus({preventScroll:true});};
    // The store owns connection generations; component callbacks must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  const items=useMemo(()=>{const q=search.trim().toLowerCase();return notes.items.filter(item=>!q||[item.text,item.deviceName,...(item.tags??[])].some(value=>value?.toLowerCase().includes(q)));},[notes.items,search]);
  const copy=async(item:ClipItem)=>{
    const current=++revision.current;setError('');setManual('');setCopied('');
    try{
      if(item.kind==='text')await copyBrowserText(item.text??'');
      else if(item.imagePath)await copyBrowserImage(item.imagePath,item.mime??'image/png');
      else throw new Error('Load this image before copying it.');
      if(current!==revision.current)return;
      setCopied(item.id);if(copiedTimer.current)clearTimeout(copiedTimer.current);copiedTimer.current=setTimeout(()=>setCopied(''),1400);
    }catch(reason){if(current!==revision.current)return;setError(reason instanceof Error?reason.message:'Copy failed. Select the note text and copy it manually.');if(item.kind==='text')setManual(item.id);}
  };
  const loadImage=async(id:string)=>{setLoading(id);setError('');const current=revision.current;try{await notes.loadImage(id);}catch{if(mounted.current&&current===revision.current)setError('Image could not be loaded. Try again.');}finally{if(mounted.current)setLoading('');}};
  return createPortal(
    <div className="fixed inset-0 z-[100] flex justify-end" style={{touchAction:'auto'}}>
      <button type="button" aria-label="Close notes backdrop" className="absolute inset-0 bg-black/45" onClick={()=>closeRef.current()}/>
      <aside ref={dialog} role="dialog" aria-modal="true" aria-labelledby="browser-notes-title" tabIndex={-1} className="relative flex h-full w-full max-w-[27rem] select-text flex-col border-l border-white/10 bg-bg-base text-ink shadow-float outline-none" onKeyDown={event=>{
        event.stopPropagation();if(event.key==='Escape'){event.preventDefault();closeRef.current();return;}
        if(event.key==='Tab'){const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,textarea')??[]),first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
      }}>
        <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-3" style={{paddingTop:'max(.75rem, env(safe-area-inset-top))'}}>
          <NotebookPen className="h-5 w-5 text-accent-3"/>
          <div className="min-w-0 flex-1"><h2 id="browser-notes-title" className="text-sm font-800">Notes</h2><p role="status" className="text-[11px] text-ink-dim">{notes.connected?'Synced with your desktop':notes.ready?'Connecting…':'Waiting for your paired PC’s Notes key'}</p></div>
          <button type="button" onClick={()=>closeRef.current()} aria-label="Close notes" className="grid h-9 w-9 place-items-center rounded-lg text-ink-soft hover:bg-white/10"><X className="h-4 w-4"/></button>
        </header>
        <div className="shrink-0 space-y-2 p-3">
          <p className="text-xs text-ink-soft">Desktop copies appear here. Copy saves to this browser’s clipboard.</p>
          <label className="relative block"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-dim"/><input aria-label="Search desktop notes" placeholder="Search notes" value={search} onChange={event=>{setSearch(event.target.value);setLimit(24);}} className="input w-full py-2 pl-8 text-xs"/></label>
          {error&&<p role="alert" className="rounded-lg border border-amber/25 bg-amber/10 p-2 text-xs text-amber">{error}</p>}
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-3 pb-3">
          {!items.length&&<p className="rounded-xl border border-white/10 p-4 text-xs leading-relaxed text-ink-dim">{search?'No matching notes.':!notes.ready?'Connect with your PC’s permanent key, or approve this browser on the PC, to sync Notes.':'Copy text on your desktop to see it here. Notes and clipboard capture must be enabled in the desktop app.'}</p>}
          {items.slice(0,limit).map(item=><article key={item.id} className="space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
            {item.kind==='text'?<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed">{item.text}</pre>:item.imagePath?<img src={item.imagePath} alt="Desktop clipboard image" className="max-h-52 max-w-full rounded-lg object-contain"/>:<button type="button" onClick={()=>void loadImage(item.id)} disabled={!!loading} className="btn-subtle flex w-full items-center justify-center gap-2 py-5 text-xs">{loading===item.id?<Loader2 className="h-4 w-4 animate-spin"/>:<ImageIcon className="h-4 w-4"/>}Load image</button>}
            {manual===item.id&&<textarea aria-label="Select note text to copy" readOnly value={item.text??''} onFocus={event=>event.target.select()} className="input min-h-24 w-full text-xs"/>}
            <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[10px] text-ink-dim">{item.pinned?'Pinned · ':''}{item.deviceName??'Desktop'} · {relativeTime(item.createdUtc)}</span>
              {item.kind==='image'&&item.imagePath&&<a href={item.imagePath} download={`clipboard-${item.id}.png`} title="Save image" className="grid h-8 w-8 place-items-center rounded-lg bg-white/5 text-ink-soft"><Download className="h-3.5 w-3.5"/></a>}
              <button type="button" onClick={()=>void copy(item)} disabled={item.kind==='image'&&!item.imagePath} aria-label={`${copied===item.id?'Copied':'Copy'} ${item.kind==='image'?'image':'note'}`} className="flex min-h-8 items-center gap-1 rounded-lg bg-accent-3/15 px-2 text-xs font-700 text-accent-3 disabled:opacity-40">{copied===item.id?<Check className="h-3.5 w-3.5"/>:<Copy className="h-3.5 w-3.5"/>}{copied===item.id?'Copied':'Copy'}</button>
            </div>
          </article>)}
          {items.length>limit&&<button type="button" onClick={()=>setLimit(value=>value+24)} className="btn-subtle w-full py-2 text-xs">Load more notes</button>}
        </div>
      </aside>
    </div>,document.body,
  );
}
