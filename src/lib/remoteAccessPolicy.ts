import publicSettingKeys from './remotePublicSettings.json';

export type RemoteAccessLevel = 'none' | 'temporary' | 'permanent' | 'secret';

export function remoteAccessLevel(value: unknown): RemoteAccessLevel {
  return value === 'temporary' || value === 'permanent' || value === 'secret' ? value : 'none';
}

/** Temporary screen control never grants the durable Notes/Voice encryption key. */
export function maySharePermanentSecret(level: RemoteAccessLevel): boolean {
  return level === 'permanent' || level === 'secret';
}

/** Default-deny: adding a desktop setting cannot silently publish it to peers. */
export function remotePublicSettings(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(publicSettingKeys.filter(key => Object.prototype.hasOwnProperty.call(settings, key)).map(key => [key, settings[key]]));
}
