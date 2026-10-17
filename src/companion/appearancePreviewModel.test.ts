import { expect,it } from 'vitest';
import { AppearancePreviewClock,appearancePreviewPoint } from './appearancePreviewModel';
it('integrates the same motion at 60/120Hz despite throttled paints',()=>{
  for(const hz of [60,120]){const c=new AppearancePreviewClock(0);let paints=0;for(let frame=1;frame<=hz;frame++){if(c.step(frame*1000/hz,.4,false,false).paint)paints++;}expect(c.phase).toBeCloseTo(.4,6);expect(paints).toBeLessThanOrEqual(25);expect(paints).toBeGreaterThan(15);}
});
it('pauses reduced/hidden preview motion and resumes without integrating a hidden gap',()=>{
  const c=new AppearancePreviewClock(0);c.step(50,1,false,false);expect(c.phase).toBe(.05);c.step(100,1,true,false);c.step(10000,1,false,true);c.step(11000,1,false,false);expect(c.phase).toBe(.05);c.step(11050,1,false,false);expect(c.phase).toBeCloseTo(.1);
});
it('maps the first touch-down from its own coordinates without a preceding move',()=>{
  expect(appearancePreviewPoint({clientX:270,clientY:140},{left:70,top:40,width:400,height:200})).toEqual({x:400,y:200});
  expect(appearancePreviewPoint({clientX:70,clientY:40},{left:70,top:40,width:400,height:200})).toEqual({x:0,y:0});
});
