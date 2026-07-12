/**
 * Device identity for the host's approval prompt. Reuses the companion's stable
 * per-install uuid, but names the device after the headset model — the Meta
 * Quest Browser UA looks like:
 *   Mozilla/5.0 (X11; Linux x86_64; Quest 3) ... OculusBrowser/33.x ...
 */

export { deviceId } from "@/companion/device";

export function questDeviceName(): string {
  const ua = navigator.userAgent || "";
  const m = ua.match(/Quest[^);]*/i);
  if (m) return `Meta ${m[0].trim()}`;
  if (/OculusBrowser/i.test(ua)) return "Meta Quest";
  return "VR headset";
}

/** True when running inside the Meta Quest Browser. */
export function isQuestBrowser(): boolean {
  return /OculusBrowser/i.test(navigator.userAgent || "");
}
