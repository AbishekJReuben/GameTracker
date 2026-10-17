type Input={type?:unknown;events?:unknown};
/** Foreground keyboard/text and gamepad state do not depend on screen geometry.
 * Mixed sequences remain atomic; only their necessary releases may escape a
 * pending coordinate gate on the native side. */
export function coordinateIndependent(message:Input):boolean{
  return ['text','key','keydown','keyup','gamepad','gamepadstop'].includes(String(message.type))
    ||message.type==='seq'&&Array.isArray(message.events)&&message.events.every(event=>event&&typeof event==='object'&&coordinateIndependent(event));
}
export function includesRelease(message:Input):boolean{
  return ['up','keyup','gamepadstop'].includes(String(message.type))||message.type==='seq'&&Array.isArray(message.events)&&message.events.some(event=>event&&typeof event==='object'&&includesRelease(event));
}
