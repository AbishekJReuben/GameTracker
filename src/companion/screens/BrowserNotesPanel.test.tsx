import React from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ClipItem} from '@/lib/clip';
const fixture=vi.hoisted(()=>({items:[] as ClipItem[],connected:true,ready:true,init:vi.fn(),stop:vi.fn(),loadImage:vi.fn(),text:vi.fn(),image:vi.fn()}));
vi.mock('../clipboardCompanion',()=>({useCompanionClip:()=>fixture}));
vi.mock('../browserClipboard',()=>({copyBrowserText:fixture.text,copyBrowserImage:fixture.image}));
import BrowserNotesPanel from './BrowserNotesPanel';
const note=(id:string,text:string):ClipItem=>({id,text,kind:'text',size:text.length,createdUtc:'2026-10-19T16:00:00Z',deviceId:'desktop',deviceName:'My PC',source:'auto',pinned:false});
beforeEach(()=>{vi.clearAllMocks();fixture.items=[note('one','Text copied on desktop'),note('two','Another note')];fixture.connected=true;fixture.ready=true;fixture.init.mockResolvedValue(undefined);fixture.text.mockResolvedValue(undefined);fixture.image.mockResolvedValue(undefined);});
afterEach(()=>cleanup());
it('shows synced desktop text, searches it and copies locally with confirmed feedback',async()=>{
  render(<BrowserNotesPanel onClose={()=>{}}/>);expect(fixture.init).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByRole('textbox',{name:'Search desktop notes'}),{target:{value:'Text copied'}});expect(screen.queryByText('Another note')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Copy note'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Copied note'})).toBeInTheDocument());expect(fixture.text).toHaveBeenCalledWith('Text copied on desktop');
});
it('exposes selectable full text after a failed copy and never says Copied',async()=>{
  fixture.items=[note('one','Full text')];fixture.text.mockRejectedValue(new Error('Select and copy manually.'));
  render(<BrowserNotesPanel onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Copy note'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Select and copy manually.');expect(screen.getByRole('textbox',{name:'Select note text to copy'})).toHaveValue('Full text');expect(screen.queryByRole('button',{name:'Copied note'})).not.toBeInTheDocument();
});
it('stops sync on close/unmount and handles Escape as a local panel action',()=>{
  const close=vi.fn(),view=render(<BrowserNotesPanel onClose={close}/>);fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(close).toHaveBeenCalledOnce();view.unmount();expect(fixture.stop).toHaveBeenCalledOnce();
});
it('does not download image data until requested and supplies copy/save for a loaded image',async()=>{
  fixture.items=[{...note('image',''),kind:'image',imagePath:'blob:loaded',mime:'image/png'}];render(<BrowserNotesPanel onClose={()=>{}}/>);
  expect(fixture.loadImage).not.toHaveBeenCalled();expect(screen.getByTitle('Save image')).toHaveAttribute('download');fireEvent.click(screen.getByRole('button',{name:'Copy image'}));await waitFor(()=>expect(fixture.image).toHaveBeenCalledWith('blob:loaded','image/png'));
});
it('keeps image loading usable when another note is copied during the download',async()=>{
  let done!:()=>void;fixture.loadImage.mockReturnValueOnce(new Promise<void>(resolve=>{done=resolve;}));fixture.items=[{...note('image',''),kind:'image'},note('text','Copy me')];render(<BrowserNotesPanel onClose={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Load image'}));fireEvent.click(screen.getByRole('button',{name:'Copy note'}));await act(async()=>{done();});expect(screen.getByRole('button',{name:'Load image'})).toBeEnabled();
});
