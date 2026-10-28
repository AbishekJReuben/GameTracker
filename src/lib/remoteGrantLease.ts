export interface RemoteGrantSnapshot {
  trusted: readonly { id: string }[];
  temporary: readonly { id: string; expiresUtc: string }[];
}
export type GrantFailure = 'revoked' | 'expired' | 'stale' | 'unavailable';

/** Session-bound, read-only grant checks. Never resubmit a pairing secret here:
 * doing so could silently recreate the very grant the owner just revoked. */
export class RemoteGrantLease {
  private until = 0;
  private expires = 0;
  private closed = false;
  private pending: Promise<boolean> | null = null;
  private level: 'none' | 'temporary' | 'permanent' = 'none';

  constructor(
    readonly deviceId: string,
    private readonly load: () => Promise<RemoteGrantSnapshot>,
    private readonly invalid: (reason: GrantFailure) => void,
    private readonly now: () => number = Date.now,
    private readonly freshnessMs = 5000,
  ) {}

  get accessLevel() { return this.level; }

  private deny(reason: GrantFailure): false {
    if (!this.closed) { this.close(); this.invalid(reason); }
    return false;
  }

  check(): boolean {
    if (this.closed) return false;
    if (this.now() >= this.expires) return this.deny('expired');
    if (this.now() >= this.until) return this.deny('stale');
    return this.level !== 'none';
  }

  refresh(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.pending) return this.pending;
    const started = this.now();
    this.pending = (async () => {
      try {
        const grants = await this.load();
        if (this.closed) return false;
        if (this.now() >= started + this.freshnessMs) return this.deny('stale');
        if (!Array.isArray(grants?.trusted) || !Array.isArray(grants?.temporary)) return this.deny('unavailable');
        if (grants.trusted.some(g => g.id === this.deviceId)) {
          this.level = 'permanent'; this.expires = Infinity;
        } else {
          const grant = grants.temporary.find(g => g.id === this.deviceId);
          if (!grant) return this.deny('revoked');
          const expires = Date.parse(grant.expiresUtc);
          if (!Number.isFinite(expires) || expires <= this.now()) return this.deny('expired');
          this.level = 'temporary'; this.expires = expires;
        }
        this.until = started + this.freshnessMs;
        return this.check();
      } catch { return this.closed ? false : this.deny('unavailable'); }
      finally { this.pending = null; }
    })();
    return this.pending;
  }

  close(): void { this.closed = true; this.level = 'none'; this.until = 0; this.expires = 0; }
}
