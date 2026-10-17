import { describe, expect, it } from 'vitest';
import { NativeDecoderRecovery } from './nativeDecoderRecovery';

function fixture() {
  const policy = new NativeDecoderRecovery();
  let now = 0, fed = 48256, output = '3990';
  const tick = (opts: { picture?: boolean; receiving?: boolean; csd?: boolean; gap?: number } = {}) => {
    now += opts.gap ?? 250;
    const receiving = opts.receiving !== false;
    if (receiving) fed++;
    if (opts.picture) output = String(Number(output) + 1);
    return policy.observe({ now, fed, output, receiving, csdQueued: opts.csd !== false });
  };
  const untilAction = (action: string, opts = {}) => {
    for (let i = 0; i < 50; i++) { const r = tick(opts); if (r.action === action) return r; }
    throw new Error(`No ${action} action`);
  };
  return { policy, tick, untilAction };
}

describe('native decoder recovery budget', () => {
  it('requests an IDR first, then restarts a silent codec with no vendor error', () => {
    const f = fixture(); f.tick();
    expect(f.untilAction('keyframe').stalledMs).toBe(750);
    const restart = f.untilAction('restart');
    expect(restart.stalledMs).toBe(2000);
    expect(restart.fedSinceProgress).toBe(9); // window count, not 48256 lifetime inputs
  });

  it('a keyframe that restores real picture progress avoids a restart', () => {
    const f = fixture(); f.tick(); f.untilAction('keyframe');
    for (let i = 0; i < 60; i++) expect(f.tick({ picture: true }).action).toBe('wait');
  });

  it('allows initial CSD setup eight seconds rather than the running-codec budget', () => {
    const f = fixture(); f.tick({ csd: false });
    expect(f.untilAction('restart', { csd: false }).stalledMs).toBe(8000);
  });

  it('does not restart for an idle desktop or disconnected input stream', () => {
    const f = fixture(); f.tick({ picture: true });
    for (let i = 0; i < 100; i++) expect(f.tick({ receiving: false }).action).toBe('wait');
  });

  it('requires new submitted work after a healthy picture', () => {
    const p = new NativeDecoderRecovery();
    for (let now = 0; now < 15000; now += 250) {
      expect(p.observe({ now, fed: 12, output: '12', receiving: true, csdQueued: true }).action).toBe('wait');
    }
  });

  it('forgets stalled time across a throttled/background poll gap', () => {
    const f = fixture(); f.tick(); f.untilAction('keyframe');
    expect(f.tick({ gap: 30000 }).action).toBe('wait');
    expect(f.tick().action).toBe('wait');
  });

  it('limits restarts even if each sick codec produces one picture', () => {
    const f = fixture(); f.tick();
    f.untilAction('restart'); f.tick({ picture: true });
    f.untilAction('restart'); f.tick({ picture: true });
    expect(f.untilAction('fallback').stalledMs).toBe(2000);
  });

  it('keeps the restart budget across resolution/monitor rebuilds', () => {
    const f = fixture(); f.tick(); f.untilAction('restart');
    f.policy.resetProgress(); f.untilAction('restart');
    f.policy.resetProgress(); f.untilAction('fallback');
  });

  it('allows a later isolated stall to recover after the minute budget expires', () => {
    const f = fixture(); f.tick(); f.untilAction('restart'); f.untilAction('restart'); f.untilAction('fallback');
    f.tick({ gap: 61000, picture: true });
    expect(f.untilAction('restart').action).toBe('restart');
  });
});
