/** The shipping rtcHost authorization startup, with a liveness gate after every
 * asynchronous boundary. A retired session must never touch shared pipelines,
 * the successor's track, channel, or clipboard secret. */
export interface AuthorizedStartup {
  isAlive():boolean;
  registerPresence():Promise<void>;
  activate():void;
  startVideo():Promise<void> | undefined;
  startAudio():Promise<void> | undefined;
  requestRecoveryFrame():Promise<void> | undefined;
  showTrack():void;
  acknowledge():void;
  onVideoError?(error:unknown):void;
}
/** Guard queued channel callbacks before even parsing/auth-retrying them. */
export function onlyLiveSession<E>(isAlive:()=>boolean,handle:(event:E)=>void|Promise<void>) {
  return (event:E)=>{if(isAlive())return handle(event);};
}
export async function runAuthorizedStartup(s:AuthorizedStartup):Promise<boolean> {
  if(!s.isAlive())return false;
  await s.registerPresence();
  if(!s.isAlive())return false;
  s.activate();
  try {await s.startVideo();}catch(error){s.onVideoError?.(error);}
  if(!s.isAlive())return false;
  try {await s.startAudio();}catch{/* audio is optional */}
  if(!s.isAlive())return false;
  try {await s.requestRecoveryFrame();}catch{/* optional API */}
  if(!s.isAlive())return false;
  s.showTrack();
  s.acknowledge();
  return true;
}
