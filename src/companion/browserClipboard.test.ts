import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {copyBrowserImage,copyBrowserText} from './browserClipboard';

const priorExec=Object.getOwnPropertyDescriptor(document,'execCommand');
beforeEach(()=>{document.body.innerHTML='';});
afterEach(()=>{vi.unstubAllGlobals();if(priorExec)Object.defineProperty(document,'execCommand',priorExec);else Reflect.deleteProperty(document,'execCommand');});
describe('browser-local clipboard writes',()=>{
  it('copies the full Unicode text using the local clipboard',async()=>{
    const writeText=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:{writeText}});
    await copyBrowserText('Desktop → browser\nதமிழ் 🎮');expect(writeText).toHaveBeenCalledWith('Desktop → browser\nதமிழ் 🎮');expect(document.querySelector('textarea')).toBeNull();
  });
  it('uses a selected-text fallback and restores focus when permission is refused',async()=>{
    const previous=document.createElement('button');document.body.append(previous);previous.focus();
    vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn().mockRejectedValue(new Error('Denied'))}});
    const fallback=vi.fn(()=>{expect(document.querySelector('textarea')?.value).toBe('full text');return true;});Object.defineProperty(document,'execCommand',{value:fallback,configurable:true});
    await copyBrowserText('full text');expect(fallback).toHaveBeenCalledWith('copy');expect(document.activeElement).toBe(previous);expect(document.querySelector('textarea')).toBeNull();
  });
  it('reports failure instead of claiming a copy when both paths are blocked',async()=>{
    vi.stubGlobal('navigator',{});Object.defineProperty(document,'execCommand',{value:()=>false,configurable:true});
    await expect(copyBrowserText('manual copy')).rejects.toThrow('Select the note text');expect(document.querySelector('textarea')).toBeNull();
  });
  it('offers image saving when the browser cannot write images',async()=>{
    vi.stubGlobal('navigator',{});await expect(copyBrowserImage('blob:image')).rejects.toThrow('Save image');
  });
  it('starts an image write inside the gesture before awaiting its downloaded blob',async()=>{
    let resolve!:(response:Response)=>void;const response=new Promise<Response>(yes=>{resolve=yes;});vi.stubGlobal('fetch',vi.fn(()=>response));
    class Item{constructor(readonly data:Record<string,Promise<Blob>>) {}}
    vi.stubGlobal('ClipboardItem',Item);const write=vi.fn(async(items:Item[])=>{await items[0].data['image/png'];});vi.stubGlobal('navigator',{clipboard:{write}});
    const copying=copyBrowserImage('blob:image');expect(write).toHaveBeenCalledOnce();resolve({ok:true,blob:async()=>new Blob(['png'],{type:'image/png'})} as Response);await copying;
  });
});
