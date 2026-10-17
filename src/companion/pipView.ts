import type {AppliedCaptureView,PhysicalRect} from '@/lib/displayLayout';
export interface ViewCamera{mode:'single'|'all';selected:string;zoom:number;pan:{x:number;y:number}}
export function pipCrop(view:AppliedCaptureView,selected:string,width:number,height:number):PhysicalRect|null{
  const display=view.displays.find(d=>d.id===selected);if(!display||width<1||height<1)return null;
  return {x:(display.x-view.source.x)/view.source.width*width,y:(display.y-view.source.y)/view.source.height*height,width:display.width/view.source.width*width,height:display.height/view.source.height*height};
}
export function pipFit(view:AppliedCaptureView,selected:string,width:number,height:number){
  const crop=pipCrop(view,selected,view.width,view.height);if(!crop||width<1||height<1)return {zoom:1,pan:{x:0,y:0}};
  const base=Math.min(width/view.width,height/view.height),scale=Math.min(width/crop.width,height/crop.height);
  return {zoom:scale/base,pan:{x:(view.width/2-crop.x-crop.width/2)*scale,y:(view.height/2-crop.y-crop.height/2)*scale}};
}
export function restorePipCamera(saved:ViewCamera,view:AppliedCaptureView):ViewCamera{
  return {...saved,pan:{...saved.pan},selected:view.displays.some(d=>d.id===saved.selected)?saved.selected:view.selectedDisplayId};
}
