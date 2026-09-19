// CPU-only receiver preparation benchmark. Does NOT measure device decoding,
// WebView IPC, network latency, rendering, or glass-to-glass performance.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import ts from "typescript";
const source = readFileSync(new URL("../src/companion/videoReceive.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { nativeVideoPacket } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

// Previous shipping implementation, kept here only as the comparison baseline.
function legacyBase64(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i += 0x8000) str += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(str);
}
let guard = 0;
function medianMs(run, count) {
  for (let i = 0; i < 20; i++) guard += run();
  const times = [];
  for (let batch = 0; batch < 7; batch++) {
    const before = performance.now();
    for (let i = 0; i < count; i++) guard += run();
    times.push((performance.now() - before) / count);
  }
  return times.sort((a, b) => a - b)[3];
}
console.log(`Encoded-frame preparation only (${process.version}, ${process.arch}); median ms/AU`);
for (const size of [32768, 65536, 524288]) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i & 255);
  const count = size > 65536 ? 30 : 100;
  const oldMs = medianMs(() => legacyBase64(bytes).length, count);
  const binaryMs = medianMs(() => nativeVideoPacket(1, false, bytes).byteLength, count);
  console.log(JSON.stringify({ bytes: size, base64Ms: +oldMs.toFixed(4), binaryMs: +binaryMs.toFixed(4),
    base64Characters: Math.ceil(size / 3) * 4, binaryBytes: size + 20 }));
}
if (!guard) throw new Error("benchmark not executed");
