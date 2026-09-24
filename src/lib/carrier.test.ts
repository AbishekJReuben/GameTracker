import { describe, expect, it } from "vitest";
import {
  CARRIER_TRAILER, REC_CONFIG, REC_KEY, SeqOrderer, boostCarrierSdp, packCarrierFrame, unpackCarrierFrame,
} from "./carrier";

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

describe("carrier framing", () => {
  it("round-trips VP8 + several records", () => {
    const vp8 = bytes(123, 1);
    const recs = [
      { flags: REC_CONFIG, seq: 0, tsMs: 0, data: new TextEncoder().encode('{"codec":"avc1.640C2A","w":1920,"h":1080}') },
      { flags: REC_KEY, seq: 41, tsMs: 1234.5, data: bytes(30000, 2) },
      { flags: 0, seq: 42, tsMs: 1251.25, data: bytes(4000, 3) },
    ];
    const buf = packCarrierFrame(vp8, recs);
    expect(buf.byteLength).toBe(123 + 3 * 17 + 30000 + 4000 + recs[0].data.length + CARRIER_TRAILER);
    const got = unpackCarrierFrame(buf)!;
    expect(got.vp8Len).toBe(123);
    expect(new Uint8Array(buf, 0, 123)).toEqual(vp8);
    expect(got.records.map((r) => [r.flags, r.seq, r.tsMs, r.data.length])).toEqual(
      recs.map((r) => [r.flags, r.seq, r.tsMs, r.data.length]),
    );
    expect(got.records[1].data).toEqual(recs[1].data);
    expect(got.records[2].data).toEqual(recs[2].data);
  });

  it("an empty record list still round-trips (VP8 only)", () => {
    const got = unpackCarrierFrame(packCarrierFrame(bytes(50, 9), []))!;
    expect(got).toEqual({ vp8Len: 50, records: [] });
  });

  it("passes plain VP8 and anything malformed through as null", () => {
    expect(unpackCarrierFrame(bytes(200, 4).buffer)).toBeNull();
    expect(unpackCarrierFrame(new ArrayBuffer(3))).toBeNull();
    const buf = packCarrierFrame(bytes(10, 1), [{ flags: 0, seq: 1, tsMs: 1, data: bytes(100, 2) }]);
    const cut = buf.slice(1); // lengths no longer add up
    expect(unpackCarrierFrame(cut)).toBeNull();
    const bad = new Uint8Array(buf.slice(0));
    bad[bad.length - 6] = 9; // version
    expect(unpackCarrierFrame(bad.buffer)).toBeNull();
  });
});

describe("SeqOrderer", () => {
  it("delivers in order and drains a hole filled by the other transport", () => {
    const o = new SeqOrderer<number>();
    expect(o.push(10, true, 10, 0).out).toEqual([10]);
    expect(o.push(11, false, 11, 1).out).toEqual([11]);
    // RTP overtakes the last SCTP frames during a switch.
    expect(o.push(13, false, 13, 2).out).toEqual([]);
    expect(o.push(14, false, 14, 3).out).toEqual([]);
    const r = o.push(12, false, 12, 4);
    expect(r).toEqual({ out: [12, 13, 14], lost: false });
    expect(o.expected).toBe(15);
  });

  it("drops late duplicates", () => {
    const o = new SeqOrderer<number>();
    o.push(5, true, 5, 0);
    o.push(6, false, 6, 0);
    expect(o.push(5, false, 5, 1).out).toEqual([]);
  });

  it("gives up on a gap after the hold time and reports the loss", () => {
    const o = new SeqOrderer<number>(250, 12);
    o.push(1, true, 1, 0);
    expect(o.push(3, false, 3, 10).out).toEqual([]);
    expect(o.poll(100)).toEqual({ out: [], lost: false });
    expect(o.poll(300)).toEqual({ out: [3], lost: true });
    expect(o.push(4, false, 4, 301).out).toEqual([4]);
  });

  it("gives up early when too many frames pile up behind a gap", () => {
    const o = new SeqOrderer<number>(10_000, 3);
    o.push(1, true, 1, 0);
    for (let s = 3; s <= 5; s++) expect(o.push(s, false, s, 1).out).toEqual([]);
    const r = o.push(6, false, 6, 2);
    expect(r).toEqual({ out: [3, 4, 5, 6], lost: true });
  });

  it("a keyframe past a gap is delivered at once and restarts the chain", () => {
    const o = new SeqOrderer<number>();
    o.push(1, true, 1, 0);
    o.push(3, false, 3, 1); // held behind missing 2
    const r = o.push(4, true, 4, 2);
    expect(r).toEqual({ out: [4], lost: false });
    expect(o.holding).toBe(0);
    expect(o.push(5, false, 5, 3).out).toEqual([5]);
  });

  it("treats a large jump either way as a new host session", () => {
    const o = new SeqOrderer<number>();
    o.push(5000, true, 5000, 0);
    expect(o.push(0, true, 0, 1).out).toEqual([0]);
    expect(o.push(1, false, 1, 2).out).toEqual([1]);
  });

  it("works across the u32 wrap", () => {
    const o = new SeqOrderer<number>();
    o.push(0xffffffff, true, 1, 0);
    expect(o.push(0, false, 2, 1).out).toEqual([2]);
    expect(o.push(2, false, 4, 2).out).toEqual([]);
    expect(o.push(1, false, 3, 3).out).toEqual([3, 4]);
  });
});

describe("boostCarrierSdp", () => {
  const sdp = [
    "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98", "a=mid:0", "a=rtpmap:96 H264/90000",
    "a=fmtp:96 profile-level-id=42e01f", "a=rtpmap:97 VP8/90000", "a=rtpmap:98 rtx/90000", "a=fmtp:98 apt=97",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=mid:1", "a=rtpmap:111 opus/48000/2",
    "m=video 9 UDP/TLS/RTP/SAVPF 97 98", "a=mid:3", "a=rtpmap:97 VP8/90000", "a=rtpmap:98 rtx/90000", "a=fmtp:98 apt=97",
    "",
  ].join("\r\n");

  it("adds the bitrate hints to the carrier's VP8 only", () => {
    const out = boostCarrierSdp(sdp, "3", 15000, 3000, 40000);
    const lines = out.split("\r\n");
    const at = lines.indexOf("a=mid:3");
    expect(lines.slice(at)).toContain("a=fmtp:97 x-google-start-bitrate=15000;x-google-min-bitrate=3000;x-google-max-bitrate=40000");
    // The primary video section (mid 0) is untouched, RTX (apt=) too.
    expect(lines.slice(0, at).some((l) => l.includes("x-google"))).toBe(false);
    expect(lines).toContain("a=fmtp:98 apt=97");
  });

  it("extends an existing VP8 fmtp line and is idempotent", () => {
    const withFmtp = sdp.replace("a=mid:3\r\na=rtpmap:97 VP8/90000", "a=mid:3\r\na=rtpmap:97 VP8/90000\r\na=fmtp:97 max-fr=60");
    const once = boostCarrierSdp(withFmtp, "3", 10000, 2000, 30000);
    expect(once).toContain("a=fmtp:97 max-fr=60;x-google-start-bitrate=10000");
    expect(boostCarrierSdp(once, "3", 10000, 2000, 30000)).toBe(once);
  });

  it("leaves the SDP alone when the mid isn't there", () => {
    expect(boostCarrierSdp(sdp, "9", 1, 1, 1)).toBe(sdp);
  });
});
