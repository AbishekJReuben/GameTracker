import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { VisibleQueryRefresh } from "./visibleQueryRefresh";

describe("hidden desktop refreshes", () => {
  it("coalesces 1000 backend updates without refetching, then catches up once", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const queryFn = vi.fn(async () => 1);
    const observer = new QueryObserver(client, { queryKey: ["sessions", "today"], queryFn });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    let visible = false;
    const refresh = new VisibleQueryRefresh(client, () => visible);
    for (let i = 0; i < 1000; i++) refresh.invalidate(["sessions"]);
    refresh.flush();
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(["sessions", "today"])?.isInvalidated).toBe(true);
    visible = true; refresh.flush(); refresh.flush();
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    unsubscribe(); client.clear();
  });
});
