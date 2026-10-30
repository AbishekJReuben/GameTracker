// Turns a key press into the text the orb's RegisterHotKey reads (see hotkey.rs).

const NAMED: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  return NAMED[code] ?? null;
}

/** The shortcut for this press, or null if it isn't one yet (only modifiers so far)
 *  or wouldn't be safe (a plain letter would stop working in every app). */
export function comboOf(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const parts = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean) as string[];
  const functionKey = /^F\d/.test(key);
  if (!functionKey && !e.ctrlKey && !e.altKey && !e.metaKey) return null;
  return [...parts, key].join("+");
}
