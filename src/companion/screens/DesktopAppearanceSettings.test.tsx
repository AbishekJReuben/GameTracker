import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import { DesktopAppearanceSettings } from './DesktopAppearanceSettings';
import { appearancePreset,readAppearance } from '../remotePreferences';
beforeEach(()=>{localStorage.clear();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('preserves the last custom configuration across presets and scopes group/appearance resets',()=>{
  localStorage.setItem('gt.streamTune','quality-marker');localStorage.setItem('gt.secret','credential-marker');render(<DesktopAppearanceSettings/>);
  expect(screen.getByRole('button',{name:'Subtle'})).toHaveAttribute('aria-pressed','true');
  fireEvent.change(within(screen.getByRole('group',{name:'Border'})).getByRole('slider',{name:'Thickness'}),{target:{value:'3'}});fireEvent.change(screen.getByRole('slider',{name:'Radius'}),{target:{value:'77'}});
  expect(readAppearance().preset).toBe('Custom');fireEvent.click(screen.getByRole('button',{name:'Balanced'}));expect(readAppearance().value.border.thickness).toBe(appearancePreset('Balanced').border.thickness);
  fireEvent.click(screen.getByRole('button',{name:'Restore custom'}));expect(readAppearance().value.border.thickness).toBe(3);
  fireEvent.click(screen.getByRole('button',{name:'Reset border'}));expect(readAppearance().value.border).toEqual(appearancePreset('Subtle').border);expect(readAppearance().value.halo.radius).toBe(77);
  fireEvent.click(screen.getByRole('button',{name:'Reset appearance'}));expect(readAppearance().value).toEqual(appearancePreset('Subtle'));expect(readAppearance().lastCustom?.halo.radius).toBe(77);
  expect(localStorage.getItem('gt.streamTune')).toBe('quality-marker');expect(localStorage.getItem('gt.secret')).toBe('credential-marker');
});
it('explains older hosts and exposes native degradation without implying active decoration',()=>{
  let listener!:(e:{event:string})=>void;const connection={remoteHandshake:null,remoteOverlayStatus:null,onEvent:vi.fn(cb=>{listener=cb;return()=>{};})};
  const {rerender}=render(<DesktopAppearanceSettings connection={connection as never}/>);expect(screen.getByRole('status',{name:'Desktop indicator status'})).toHaveTextContent('host needs updating');
  Object.assign(connection,{remoteHandshake:{version:1,capabilities:['desktop-appearance-v1'],layout:{displays:[{id:'p',name:'Primary'}]}},remoteOverlayStatus:{available:true,degraded:true,activeDisplayIds:[],failedDisplays:{p:'Affinity failed'},message:'unavailable'}});
  rerender(<DesktopAppearanceSettings connection={connection as never}/>);fireEvent.click(screen.getByRole('button',{name:'Expressive'}));listener({event:'remote-overlay-status'});
  expect(screen.getByRole('status',{name:'Desktop indicator status'})).toHaveTextContent('unavailable on one or more displays');expect(screen.getByRole('status',{name:'Desktop indicator status'})).toHaveTextContent('Remote control remains available');
});
it('includes each individual appearance group and comfort control',()=>{
  render(<DesktopAppearanceSettings/>);
  for(const name of ['Border','Aurora','Palette','Tint','Cursor halo','Click ripples','Identity label','Motion comfort'])expect(screen.getByRole('group',{name})).toBeInTheDocument();
  expect(screen.getByRole('combobox',{name:'Label placement'})).toHaveValue('topCenter');expect(screen.getByRole('combobox',{name:'Motion comfort'})).toHaveValue('system');
  expect(screen.getByRole('checkbox',{name:'Cursor halo enabled'})).toBeChecked();expect(screen.getByRole('checkbox',{name:'Click ripples enabled'})).toBeChecked();
  expect(screen.getByRole('slider',{name:'Announcement duration'})).toHaveValue('3');
});
