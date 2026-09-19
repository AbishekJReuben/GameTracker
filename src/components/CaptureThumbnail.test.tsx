import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { CaptureThumbnail } from "./CaptureThumbnail";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/remoteClient", () => ({ isCompanion: () => false }));
vi.mock("@/lib/api", () => ({ assetUrl: (path: string) => path }));

let clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(c => c.clear()); clients = []; vi.unstubAllGlobals(); invoke.mockReset(); });

function mount(count: number) {
  const observers: { callback: IntersectionObserverCallback; elements: Set<Element> }[] = [];
  class Observer {
    record: typeof observers[number];
    constructor(callback: IntersectionObserverCallback) { this.record = { callback, elements: new Set() }; observers.push(this.record); }
    observe(el: Element) { this.record.elements.add(el); }
    unobserve(el: Element) { this.record.elements.delete(el); }
    disconnect() { this.record.elements.clear(); }
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const rendered = render(<QueryClientProvider client={client}>
    {Array.from({ length: count }, (_, i) => <CaptureThumbnail key={i} path={`/media/full-${i}.png`} alt={`Capture ${i}`} />)}
  </QueryClientProvider>);
  const expose = (elements: Element[]) => act(() => {
    for (const observer of observers) observer.callback(elements.map(target => ({ target, isIntersecting: true }) as IntersectionObserverEntry), {} as IntersectionObserver);
  });
  return { ...rendered, expose, observers };
}

it("a 300-shot gallery requests only nearby thumbnails, never all original files", async () => {
  invoke.mockImplementation(async (_command: string, { path }: { path: string }) => path.replace("full", "thumb"));
  const { container, expose, observers } = mount(300);
  const imgs = [...container.querySelectorAll("img")];
  expect(invoke).not.toHaveBeenCalled();
  expect(imgs.every(i => !i.hasAttribute("src"))).toBe(true);
  expect(observers).toHaveLength(1);
  expose(imgs.slice(0, 12));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(12));
  await waitFor(() => expect(imgs[0].getAttribute("src")).toBe("/media/thumb-0.png"));
  expect(imgs.slice(12).every(i => !i.hasAttribute("src"))).toBe(true);
  expect(imgs.some(i => i.getAttribute("src")?.includes("full"))).toBe(false);
});

it("keeps the original available if thumbnail generation fails", async () => {
  invoke.mockRejectedValue(new Error("Unsupported image"));
  const { container, expose } = mount(1);
  const img = container.querySelector("img")!;
  expose([img]);
  await waitFor(() => expect(img.getAttribute("src")).toBe("/media/full-0.png"));
});
