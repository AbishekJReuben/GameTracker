// Shared-clipboard E2E crypto — the wire format every platform must agree on
// byte-for-byte (JS desktop engine, companion webview, and the Android native
// service's Java mirror). These tests pin the contract: HKDF-SHA256 with salt
// "gt-clipboard-v1", AES-256-GCM, `iv(12) || ciphertext+tag(16)`, and the
// SHA-256-truncated clipId the relay groups devices by.

import { describe, expect, it } from "vitest";
import {
  b64ToBytes,
  bytesToB64,
  clipId,
  decryptBytes,
  decryptText,
  deriveKey,
  encryptBytes,
  encryptText,
} from "./clipboardCrypto";

describe("clipboardCrypto", () => {
  it("clipId is deterministic, 16 hex chars, and secret-sensitive", async () => {
    const a = await clipId("MYSECRET1");
    const b = await clipId("MYSECRET1");
    const c = await clipId("MYSECRET2");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(c);
  });

  it("clipId matches the Java mirror's SHA-256 truncation for a known vector", async () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223... — first 8 bytes hex.
    // ClipboardService.clipId() computes exactly this; if either side drifts,
    // phone and PC land in different relay spaces and "connect" to nobody.
    expect(await clipId("abc")).toBe("ba7816bf8f01cfea");
  });

  it("text round-trips through encrypt/decrypt with the same secret", async () => {
    const key = await deriveKey("correct horse battery staple");
    const msg = "hello from the desktop 👋 — multiline\nand unicode ✓";
    const cipher = await encryptText(key, msg);
    expect(await decryptText(key, cipher)).toBe(msg);
  });

  it("ciphertext is iv(12) || ct+tag(16) and unique per encryption", async () => {
    const key = await deriveKey("s3cret");
    const c1 = b64ToBytes(await encryptText(key, "x"));
    const c2 = b64ToBytes(await encryptText(key, "x"));
    // 12-byte IV + 1 byte plaintext + 16-byte GCM tag.
    expect(c1.length).toBe(12 + 1 + 16);
    // Fresh random IV each time — identical plaintexts must not repeat bytes.
    expect(bytesToB64(c1)).not.toBe(bytesToB64(c2));
  });

  it("decryption fails with the wrong key and on tampered ciphertext", async () => {
    const right = await deriveKey("alpha");
    const wrong = await deriveKey("beta");
    const cipher = await encryptText(right, "payload");
    await expect(decryptText(wrong, cipher)).rejects.toThrow();
    const bytes = b64ToBytes(cipher);
    bytes[bytes.length - 1] ^= 0xff; // flip a tag bit
    await expect(decryptBytes(right, bytes)).rejects.toThrow();
  });

  it("binary blobs round-trip (image path)", async () => {
    const key = await deriveKey("blob-secret");
    const data = new Uint8Array(70000).map((_, i) => i % 251);
    const out = await decryptBytes(key, await encryptBytes(key, data));
    expect(out).toEqual(data);
  });

  it("b64 helpers round-trip and strip data-URL prefixes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
    expect(b64ToBytes(`data:image/png;base64,${bytesToB64(bytes)}`)).toEqual(bytes);
  });
});
