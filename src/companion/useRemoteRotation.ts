import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/lib/tauri';
import { readRotation, saveRotation } from './remotePreferences';

let revision = 0;
function nativeRotation(active: boolean, value: number): Promise<unknown> {
  revision = Math.max(revision + 1, Date.now() * 1000);
  return invoke('set_remote_rotation', { active, value, revision });
}
/** Mounted only by Remote Control. PiP leaves the component mounted, and a
 * transport reconnect does not release/re-acquire its orientation policy. */
export function useRemoteRotation() {
  const [holdMs, setHoldMs] = useState(readRotation);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    saveRotation(holdMs);
    if (isTauri()) void nativeRotation(true, holdMs).then(() => setError(null), () => setError('Rotation control is unavailable in this app build.'));
  }, [holdMs]);
  useEffect(() => () => { if (isTauri()) void nativeRotation(false, 1200).catch(() => {}); }, []);
  return { holdMs, setHoldMs, error };
}
