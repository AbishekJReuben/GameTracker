import { describe, expect, it } from 'vitest';
import fixtures from '../../docs/remote-implementation/fixtures/layouts.json';
import { clientToFrame, desktopBounds, visibleDesktopRect, desktopToFrame, displayAt, fitCaptureSize, frameToDesktop, sameView, videoContentRect, visibleDisplayIds, type AppliedCaptureView, type DisplayInfo } from './displayLayout';
const displays = (fixture: typeof fixtures[number]): DisplayInfo[] => fixture.displays.map((d,index) => ({rotation:0,...d,index,name:d.id,isPrimary:d.id === 'primary',selected:d.id === 'primary',layoutRevision:1}));
describe('physical desktop mapping', () => {
  for (const fixture of fixtures) it(`keeps positions, corners, gaps and aspect ratio: ${fixture.name}`, () => {
    const ds = displays(fixture), bounds = desktopBounds(ds)!;
    expect(bounds).toEqual(fixture.bounds);
    expect(frameToDesktop(bounds,{x:0,y:0})).toEqual({x:bounds.x,y:bounds.y});
    expect(frameToDesktop(bounds,{x:1,y:1})).toEqual({x:bounds.x+bounds.width-1,y:bounds.y+bounds.height-1});
    for (const d of ds) {
      for (const p of [{x:d.x,y:d.y},{x:d.x+d.width-1,y:d.y+d.height-1},{x:d.x+Math.floor(d.width/2),y:d.y+Math.floor(d.height/2)}]) {
        expect(displayAt(ds,p)?.id).toBe(d.id);
        expect(frameToDesktop(bounds,desktopToFrame(bounds,p))).toEqual(p);
      }
    }
    const size = fitCaptureSize(bounds,1920);
    expect(size.width).toBeLessThanOrEqual(1920);
    expect(size.width % 2).toBe(0); expect(size.height % 2).toBe(0);
    expect(Math.abs(size.width/size.height - bounds.width/bounds.height)).toBeLessThan(.025);
  });
  it('rejects gap taps, letterboxing and non-finite data instead of clicking an arbitrary screen', () => {
    const ds = displays(fixtures[5]); expect(displayAt(ds,{x:-100,y:300})).toBeUndefined();
    const content = videoContentRect(1920,540,{width:1000,height:1000,zoom:1,panX:0,panY:0});
    expect(clientToFrame({x:500,y:50},content)).toBeNull();
    expect(clientToFrame({x:500,y:500},content)).toEqual({x:.5,y:.5});
    expect(frameToDesktop(fixtures[0].bounds,{x:NaN,y:.5})).toBeNull();
  });
  it('inverts zoom/pan and decorates only intersecting monitors', () => {
    const ds = displays(fixtures[0]);
    const view: AppliedCaptureView = {epoch:2,layoutRevision:1,mode:'all',selectedDisplayId:'primary',source:fixtures[0].bounds,width:1920,height:540,displays:ds};
    const content = videoContentRect(1920,540,{width:1000,height:500,zoom:2,panX:-500,panY:0});
    const point = clientToFrame({x:500,y:250},content)!;
    expect(point.x).toBeCloseTo(.75,12); expect(point.y).toBe(.5);
    expect(visibleDisplayIds(view,content,{x:0,y:0,width:1000,height:500})).toEqual(['primary']);
    expect(sameView(view,{...view,epoch:1})).toBe(false);
    expect(sameView(view,{...view,layoutRevision:2})).toBe(false);
  });
});
describe('viewing area for the PC lens', () => {
  const d = {id:'p',index:0,name:'p',x:-1920,y:0,width:1920,height:1080,rotation:0,isPrimary:true,selected:true,layoutRevision:1};
  const view: AppliedCaptureView = {epoch:1,layoutRevision:1,mode:'single',selectedDisplayId:'p',source:d,width:1920,height:1080,displays:[d]};
  it('maps the on-screen part of the frame to physical desktop pixels', () => {
    const vp = {x:0,y:0,width:800,height:450};
    expect(visibleDesktopRect(view, videoContentRect(1920,1080,{width:800,height:450,zoom:1,panX:0,panY:0}), vp)).toEqual({x:-1920,y:0,width:1920,height:1080});
    expect(visibleDesktopRect(view, videoContentRect(1920,1080,{width:800,height:450,zoom:2,panX:0,panY:0}), vp)).toEqual({x:-1440,y:270,width:960,height:540});
    expect(visibleDesktopRect(view, videoContentRect(1920,1080,{width:800,height:450,zoom:2,panX:400,panY:225}), vp)).toEqual({x:-1920,y:0,width:960,height:540});
  });
  it('excludes letterboxing and the keyboard, and is null off-frame', () => {
    const content = videoContentRect(1920,1080,{width:800,height:800,zoom:1,panX:0,panY:0});
    expect(visibleDesktopRect(view, content, {x:0,y:0,width:800,height:800})).toEqual({x:-1920,y:0,width:1920,height:1080});
    expect(visibleDesktopRect(view, content, {x:0,y:0,width:800,height:400})?.height).toBe(540);
    expect(visibleDesktopRect(view, {x:900,y:0,width:800,height:450}, {x:0,y:0,width:800,height:450})).toBeNull();
  });
});
