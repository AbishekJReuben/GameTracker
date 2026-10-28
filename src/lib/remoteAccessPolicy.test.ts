import { describe, expect, it } from 'vitest';
import { maySharePermanentSecret, remoteAccessLevel, remotePublicSettings } from './remoteAccessPolicy';

describe('remote access disclosure policy', () => {
  it('never shares a durable key with a temporary or unapproved guest', () => {
    expect(maySharePermanentSecret('temporary')).toBe(false);
    expect(maySharePermanentSecret('none')).toBe(false);
    expect(maySharePermanentSecret('permanent')).toBe(true);
    expect(maySharePermanentSecret('secret')).toBe(true);
  });
  it('fails closed for unexpected backend access levels', () => {
    for (const value of [undefined, null, '', 'admin', 'true', {}, 1]) expect(remoteAccessLevel(value)).toBe('none');
    for (const value of ['temporary', 'permanent', 'secret'] as const) expect(remoteAccessLevel(value)).toBe(value);
  });
  it('preserves companion settings while excluding credentials, grants and future settings', () => {
    expect(remotePublicSettings({ remote_only:'true', daily_goal_minutes:'45', system_monitor_enabled:'false', remote_secret_code:'synthetic', remote_pin:'synthetic', remote_trusted_devices:'synthetic', remote_temp_grants:'synthetic', future_provider_key:'synthetic' })).toEqual({remote_only:'true',daily_goal_minutes:'45',system_monitor_enabled:'false'});
  });
  it('does not disclose inherited properties or mutate the original settings', () => {
    const input=Object.assign(Object.create({remote_only:'true'}),{remote_secret_code:'synthetic'});
    expect(remotePublicSettings(input)).toEqual({});
    expect(input.remote_secret_code).toBe('synthetic');
  });
});
