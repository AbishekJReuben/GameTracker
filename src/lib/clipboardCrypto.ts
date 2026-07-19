// End-to-end encryption for the shared clipboard.
//
// AES-256-GCM with a key derived from the user's `remote_secret_code` via
// HKDF-SHA256. The relay only ever sees ciphertext. This is the JS half of the
// wire format — the Android native service replicates it in Kotlin
// (`AES/GCM/NoPadding` + the same HKDF), so any device can decrypt any other's.
//
// Wire format: `iv(12) || ciphertext+tag`, base64 for text (inline) or raw bytes
// for image blobs (PUT/GET).

const enc = new TextEncoder();
const dec = new TextDecoder();

const SALT = enc.encode("gt-clipboard-v1");

export async function deriveKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: new Uint8Array() },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Stable relay space id for a user's devices — SHA-256(secret) truncated. The
 *  server groups devices by this without ever learning the secret. */
export async function clipId(secret: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(secret)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as BufferSource),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function decryptBytes(key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> {
  const iv = blob.slice(0, 12) as BufferSource;
  const ct = blob.slice(12) as BufferSource;
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

export async function encryptText(key: CryptoKey, text: string): Promise<string> {
  return bytesToB64(await encryptBytes(key, enc.encode(text)));
}

export async function decryptText(key: CryptoKey, cipherB64: string): Promise<string> {
  return dec.decode(await decryptBytes(key, b64ToBytes(cipherB64)));
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
