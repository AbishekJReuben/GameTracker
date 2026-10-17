import {afterEach,describe,it,expect,vi} from 'vitest';
import {TransitionPicture} from './transitionPicture';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('last valid browser picture handoff',()=>{
  it('retains one bounded picture and requires a current sink after a full paint',()=>{
    const queued:FrameRequestCallback[]=[];vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{queued.push(callback);return queued.length;});
    const drawImage=vi.fn(),canvas={width:1,height:1,hidden:true,getContext:()=>({setTransform:vi.fn(),fillRect:vi.fn(),drawImage})} as unknown as HTMLCanvasElement;
    const state=new TransitionPicture(()=>canvas),source={} as CanvasImageSource,shown=vi.fn();
    expect(state.retain(source,3840,2160,{width:10000,height:6000,zoom:1,panX:0,panY:0})).toBe(true);expect(canvas.width*canvas.height).toBeLessThanOrEqual(4_194_304);expect(canvas.hidden).toBe(false);
    state.retain(source,100,100,{width:100,height:100,zoom:1,panX:0,panY:0});expect(drawImage).toHaveBeenCalledTimes(1);
    let live=true;state.finish(()=>live,shown);expect(canvas.hidden).toBe(true);expect(shown).not.toHaveBeenCalled();queued.shift()!(0);expect(shown).not.toHaveBeenCalled();live=false;queued.shift()!(16);expect(shown).not.toHaveBeenCalled();
    state.retain(source,100,100,{width:100,height:100,zoom:1,panX:0,panY:0});state.finish(()=>true,shown);queued.shift()!(32);queued.shift()!(48);expect(shown).toHaveBeenCalledOnce();state.dispose();expect(canvas.width).toBe(1);expect(canvas.height).toBe(1);
  });
});
