import { expect, it, vi } from 'vitest';
import { CaptureStallWatchdog, HostCaptureRecovery } from './hostCaptureRecovery';
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() }; }
it('waits for stop before restarting and coalesces visibility and stall recovery', async () => {
  const stopped = deferred(), events: string[] = [];
  const r = new HostCaptureRecovery(() => true, async () => { events.push('stop'); await stopped.promise; }, async () => { events.push('start'); }, vi.fn());
  const a = r.restart(), b = r.restart(); expect(a).toBe(b); expect(events).toEqual(['stop']);
  stopped.resolve(); await a; expect(events).toEqual(['stop', 'start']);
});
it('a replaced session cannot restart capture after its stop completes', async () => {
  const stopped = deferred(), start = vi.fn(), error = vi.fn(); let alive = true;
  const r = new HostCaptureRecovery(() => alive, () => stopped.promise, start, error);
  const pending = r.restart(); alive = false; stopped.resolve(); await pending;
  expect(start).not.toHaveBeenCalled(); await r.restart(); expect(start).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
it('retries after a failed restart without parallel attempts', async () => {
  const error = vi.fn(), start = vi.fn().mockRejectedValueOnce(new Error('capture')).mockResolvedValue(undefined);
  const r = new HostCaptureRecovery(() => true, vi.fn().mockResolvedValue(undefined), start, error);
  await r.restart(); await r.restart(); expect(start).toHaveBeenCalledTimes(2); expect(error).toHaveBeenCalledTimes(1);
});
it('detects missing first frames even if the per-generation counter repeatedly resets', async () => {
  let now = 0; const recover = vi.fn().mockResolvedValue(undefined);
  const w = new CaptureStallWatchdog(() => true, () => false, async () => ({ producedFrames: 0, emittedFrames: 0 }), recover, () => now);
  for (now = 0; now <= 12_000; now += 1000) await w.poll();
  expect(recover).toHaveBeenCalledTimes(2);
});
it('does not mistake background or network backpressure pauses for a failed capture', async () => {
  let now = 0, paused = true; const recover = vi.fn().mockResolvedValue(undefined), sample = vi.fn().mockResolvedValue({ producedFrames: 0 });
  const w = new CaptureStallWatchdog(() => true, () => paused, sample, recover, () => now);
  for (now = 0; now < 60_000; now += 1000) await w.poll();
  expect(sample).not.toHaveBeenCalled(); paused = false; await w.poll(); now += 4999; await w.poll(); expect(recover).not.toHaveBeenCalled();
  now++; await w.poll(); expect(recover).toHaveBeenCalledOnce();
});
it('ignores an old peer sample completed after replacement and never overlaps polls', async () => {
  const sample = deferred(), recover = vi.fn(); let alive = true;
  const read = vi.fn(async () => { await sample.promise; return { producedFrames: 0 }; });
  const w = new CaptureStallWatchdog(() => alive, () => false, read, recover);
  const pending = w.poll(); await w.poll(); expect(read).toHaveBeenCalledOnce();
  alive = false; sample.resolve(); await pending; expect(recover).not.toHaveBeenCalled();
});
it('real frame deliveries keep the stream alive and older backends retain fallback support', async () => {
  for (const lifetime of [false, true]) {
    let now = 0; const recover = vi.fn();
    const w = new CaptureStallWatchdog(() => true, () => false, async () => ({ producedFrames: now / 1000, ...(lifetime ? { emittedFrames: now / 1000 } : {}) }), recover, () => now);
    for (now = 0; now < 60_000; now += 1000) await w.poll();
    expect(recover).not.toHaveBeenCalled();
  }
});
