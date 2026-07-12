/**
 * Diff-based text forwarding, shared by the 2D compose bar and the immersive
 * WebXR system keyboard.
 *
 * Why diffing instead of key events: soft keyboards (Android IMEs and the Quest
 * system keyboard alike) don't produce reliable per-key events — Android reports
 * keyCode 229/"Unidentified", and the Quest WebXR system keyboard exposes **no
 * key events at all**, only the text field's `value` (see
 * https://developers.meta.com/horizon/documentation/web/webxr-keyboard/). So a
 * hidden <input> accumulates text and we diff its value on every `input` event:
 * removed chars become Backspace presses, added chars become one `text` message.
 *
 * Quest immersive quirk handled by `reset()`: each time the system keyboard is
 * shown it starts a NEW editing session whose first key press overwrites the
 * entire existing value. Clearing the field (and the diff base) right before
 * every focus() makes the diff always start from "" so that overwrite can never
 * be misread as "delete everything, then type".
 */

import type { ControlMsg } from "@/companion/links";

export class TextDiffSender {
  private prev = "";

  constructor(private send: (msg: ControlMsg) => void) {}

  /** Clear the field + diff base. Call right before focusing the hidden input. */
  reset(el: HTMLInputElement | null) {
    if (el) el.value = "";
    this.prev = "";
  }

  /** Send whatever changed in the field since the last input event. */
  flush(el: HTMLInputElement | null) {
    if (!el) return;
    const val = el.value;
    const prev = this.prev;
    if (val === prev) return;
    let i = 0;
    const min = Math.min(val.length, prev.length);
    while (i < min && val[i] === prev[i]) i++;
    const removed = prev.length - i;
    const added = val.slice(i);
    for (let k = 0; k < removed; k++) this.send({ type: "key", name: "backspace" });
    if (added) this.send({ type: "text", value: added });
    this.prev = val;
    // Keep the field from growing unbounded; reset the base without emitting keys.
    if (val.length > 240) this.reset(el);
  }
}
