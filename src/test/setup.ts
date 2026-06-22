import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement these browser observers that motion/react and our
// responsive components (e.g. Heatmap) rely on. Provide inert polyfills so
// component trees render under test instead of throwing.
class MockObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = MockObserver as unknown as typeof ResizeObserver;
}
if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = MockObserver as unknown as typeof IntersectionObserver;
}
