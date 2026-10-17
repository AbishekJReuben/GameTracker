import type {ControlMsg} from './links';
/** One ordered edit transaction. The caller advances its acknowledged local
 * value only when this whole transaction is admitted to the control channel. */
export function foregroundEdit(previous:string,value:string,modifiers:Iterable<string>):ControlMsg[]{
  const old=Array.from(previous),next=Array.from(value);let prefix=0;while(prefix<Math.min(old.length,next.length)&&old[prefix]===next[prefix])prefix++;
  const events:ControlMsg[]=old.slice(prefix).map(()=>({type:'key',name:'backspace'}));const added=next.slice(prefix).join(''),mods=Array.from(modifiers);
  if(added)events.push(mods.length>0&&Array.from(added).length===1?{type:'key',name:added.toLowerCase()}:{type:'text',value:added});
  if(added)mods.forEach(name=>events.push({type:'keyup',name}));return events;
}
