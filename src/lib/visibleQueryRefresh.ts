import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** Backend work continues in the tray; its UI refreshes catch up once on return. */
export class VisibleQueryRefresh {
  private pending = new Map<string, QueryKey>();
  constructor(private client: QueryClient, private visible: () => boolean) {}
  invalidate(queryKey: QueryKey) {
    if (this.visible()) {
      void this.client.invalidateQueries({ queryKey });
    } else {
      const key = JSON.stringify(queryKey);
      if (this.pending.has(key)) return;
      this.pending.set(key, queryKey);
      // Mark stale now without waking active, but invisible, query observers.
      void this.client.invalidateQueries({ queryKey, refetchType: "none" });
    }
  }
  flush() {
    if (!this.visible()) return;
    const keys = [...this.pending.values()];
    this.pending.clear();
    for (const queryKey of keys) void this.client.invalidateQueries({ queryKey });
  }
}
