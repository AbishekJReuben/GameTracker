export { deviceId, isQuestBrowser } from "@/companion/device";

export function questDeviceName(): string {
  const ua = navigator.userAgent || "";
  const m = ua.match(/Quest[^);]*/i);
  if (m) return `Meta ${m[0].trim()}`;
  if (/OculusBrowser/i.test(ua)) return "Meta Quest";
  return "VR headset";
}
