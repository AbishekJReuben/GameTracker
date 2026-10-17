import { desktopBounds, type AppliedCaptureView, type DisplayInfo, type DisplaySnapshot, type PhysicalRect } from './displayLayout';
import type { DesktopAppearance } from '../companion/remotePreferences';
export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_CAPABILITIES = ['display-geometry-v1','all-screens-v1','view-state-v1','controller-name-v1','desktop-appearance-v1','view-epoch-input-v1'] as const;
export type RemoteCapability = typeof REMOTE_CAPABILITIES[number];
export interface RemoteOverlayStatus {available:boolean;degraded:boolean;activeDisplayIds:string[];failedDisplays:Record<string,string>;message:string|null}
export interface RemotePresenceReply {accepted:boolean;overlay:RemoteOverlayStatus}
export function parseOverlayStatus(raw:unknown):RemoteOverlayStatus|null {
  if(!raw||typeof raw!=='object')return null;const s=raw as Partial<RemoteOverlayStatus>;
  if(typeof s.available!=='boolean'||typeof s.degraded!=='boolean'||!Array.isArray(s.activeDisplayIds)||s.activeDisplayIds.length>16
    ||!s.activeDisplayIds.every(id=>typeof id==='string'&&id.length<=512)||!s.failedDisplays||typeof s.failedDisplays!=='object'||Array.isArray(s.failedDisplays)
    ||Object.entries(s.failedDisplays).length>16||!Object.entries(s.failedDisplays).every(([id,error])=>id.length<=512&&typeof error==='string'&&error.length<=1024)
    ||(s.message!==null&&typeof s.message!=='string'))return null;
  return {...s,message:s.message?.slice(0,1024)??null} as RemoteOverlayStatus;
}
export interface RemoteHandshake { version: 1; capabilities: RemoteCapability[]; sessionId: string; layout: DisplaySnapshot; view: AppliedCaptureView; overlayAvailable: boolean }
export interface RemotePresenceUpdate {
  sequence: number; displayName: string; controlVisible: boolean; pipVisible: boolean; immersiveVisible: boolean;
  mode: 'single' | 'all'; viewEpoch: number; selectedDisplayId: string; visibleDisplayIds: string[];
  appearance: DesktopAppearance;
}
export interface ClientViewReport { mode: 'single' | 'all'; epoch: number; selectedDisplayId: string; visibleDisplayIds: string[] }
export function negotiatedCapabilities(raw: unknown): RemoteCapability[] {
  if (!Array.isArray(raw)) return [];
  return REMOTE_CAPABILITIES.filter(c=>raw.includes(c));
}
export function supportsRemote(handshake: RemoteHandshake | null, capability: RemoteCapability): boolean {
  return handshake?.version === 1 && handshake.capabilities.includes(capability) === true;
}
export function parseHandshake(raw: unknown): RemoteHandshake | null {
  if (!raw || typeof raw !== 'object') return null;
  const h=raw as Partial<RemoteHandshake>;
  const integer=(n:unknown,min=0,max=Number.MAX_SAFE_INTEGER):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=min&&n<=max;
  const rect=(r:unknown):r is PhysicalRect=>!!r&&typeof r==='object'
    &&integer((r as PhysicalRect).x,-1_000_000,1_000_000)&&integer((r as PhysicalRect).y,-1_000_000,1_000_000)
    &&integer((r as PhysicalRect).width,1,1_000_000)&&integer((r as PhysicalRect).height,1,1_000_000);
  const display=(d:unknown,revision:number):d is DisplayInfo=>rect(d)&&typeof (d as DisplayInfo).id==='string'
    &&(d as DisplayInfo).id.length>0&&(d as DisplayInfo).id.length<=512&&integer((d as DisplayInfo).index,0,255)
    &&typeof (d as DisplayInfo).name==='string'&&typeof (d as DisplayInfo).isPrimary==='boolean'
    &&[0,90,180,270].includes((d as DisplayInfo).rotation)&&(d as DisplayInfo).layoutRevision===revision;
  if(h.version!==1 || typeof h.sessionId!=='string' || !h.sessionId || h.sessionId.length>128
    ||!h.layout||!integer(h.layout.revision,1)||!rect(h.layout.bounds)||!Array.isArray(h.layout.displays)
    ||h.layout.displays.length===0||h.layout.displays.length>16||!h.layout.displays.every(d=>display(d,h.layout!.revision))
    ||new Set(h.layout.displays.map(d=>d.id)).size!==h.layout.displays.length
    ||!h.view||!integer(h.view.epoch)||h.view.layoutRevision!==h.layout.revision
    ||!['single','all'].includes(h.view.mode)||!rect(h.view.source)||!integer(h.view.width,32,8192)||!integer(h.view.height,32,8192)
    ||h.view.width*h.view.height>33_177_600||!Array.isArray(h.view.displays)||h.view.displays.length===0||h.view.displays.length>16
    ||!h.view.displays.every(d=>display(d,h.layout!.revision)&&h.layout!.displays.some(source=>source.id===d.id&&source.x===d.x&&source.y===d.y&&source.width===d.width&&source.height===d.height))
    ||new Set(h.view.displays.map(d=>d.id)).size!==h.view.displays.length
    ||!h.view.displays.some(d=>d.id===h.view!.selectedDisplayId)||typeof h.overlayAvailable!=='boolean') return null;
  const bounds=desktopBounds(h.view.displays)!;
  if(bounds.x!==h.view.source.x||bounds.y!==h.view.source.y||bounds.width!==h.view.source.width||bounds.height!==h.view.source.height
    ||(h.view.mode==='single'&&h.view.displays.length!==1))return null;
  return {...h, capabilities:negotiatedCapabilities(h.capabilities)} as RemoteHandshake;
}
