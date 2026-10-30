import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RemoteLink } from "../links";
vi.hoisted(() => {
  vi.stubGlobal("__APP_VERSION__", "test");
});
vi.mock("../link", () => ({ apiGet: vi.fn(async () => null) }));
import { ControlScreen } from "./Control";

const QUEST_UA = "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 OculusBrowser/38.0 Chrome/132 VR Safari/537.36";
const PHONE_UA = "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36";

function fixture(connected = true) {
  const send = vi.fn(() => true);
  const link: RemoteLink = {
    onStream: () => {},
    onEvent: () => () => {},
    onStatus: (cb) => cb(connected),
    send,
    setQuality: () => {},
    netStats: async () => null,
    close: () => {},
  };
  return { link, send };
}

function tapPicture(type: "up" | "cancel" = "up", dragTo?: number) {
  const viewport = screen.getByTestId("remote-viewport");
  const pointer = (name: string, x: number) => {
    const event = new MouseEvent(name, { bubbles: true, cancelable: true, clientX: x, clientY: 200, button: 0, buttons: name === "pointerdown" ? 1 : 0 });
    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
    fireEvent(viewport, event);
  };
  pointer("pointerdown", 300);
  if (dragTo != null) pointer("pointermove", dragTo);
  pointer(type === "up" ? "pointerup" : "pointercancel", dragTo ?? 300);
}

const rightClicks = (send: ReturnType<typeof fixture>["send"]) =>
  (send.mock.calls as unknown[][]).filter(([m]) => (m as { type?: string; button?: string }).type === "click" && (m as { button?: string }).button === "right");

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(QUEST_UA);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("puts Quest's right click in the bottom tab strip and nowhere over the picture", () => {
  render(<ControlScreen link={fixture().link} />);
  const button = within(screen.getByTestId("dock-tabs")).getByRole("button", { name: "Right click" });
  expect(screen.getAllByRole("button", { name: "Right click" })).toEqual([button]);
  expect(button).toHaveAttribute("aria-pressed", "false");
});

it("leaves phones and web without the button", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(PHONE_UA);
  render(<ControlScreen link={fixture().link} />);
  expect(screen.queryByRole("button", { name: "Right click" })).not.toBeInTheDocument();
  expect(within(screen.getByTestId("dock-tabs")).getAllByRole("button").length).toBeGreaterThan(0);
});

it("arms, then the next tap on the PC screen right-clicks once and never left-clicks", async () => {
  const { link, send } = fixture();
  render(<ControlScreen link={link} />);
  const button = screen.getByRole("button", { name: "Right click" });
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("status")).toHaveTextContent("Tap a target on the PC");
  send.mockClear();
  tapPicture();
  expect(rightClicks(send)).toHaveLength(1);
  expect((send.mock.calls as unknown[][]).some(([m]) => ["down", "up"].includes((m as { type: string }).type))).toBe(false);
  expect(button).toHaveAttribute("aria-pressed", "false");
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
});

it("cancels when selected again, and a drag is not a right click", () => {
  const { link, send } = fixture();
  render(<ControlScreen link={link} />);
  const button = screen.getByRole("button", { name: "Right click" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(button);
  send.mockClear();
  tapPicture("up", 500);
  expect(rightClicks(send)).toHaveLength(0);
});

it("the hint never takes the tap it is asking for", () => {
  const { link } = fixture();
  render(<ControlScreen link={link} />);
  fireEvent.click(screen.getByRole("button", { name: "Right click" }));
  expect(screen.getByRole("status")).toHaveClass("pointer-events-none");
});

it("stays reachable with the dock hidden, as a round button beside the keyboard", () => {
  const { link, send } = fixture();
  render(<ControlScreen link={link} />);
  fireEvent.click(screen.getByTitle("Hide controls (full-screen viewport)"));
  expect(screen.queryByTestId("dock-tabs")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Right click" }));
  send.mockClear();
  tapPicture();
  expect(rightClicks(send)).toHaveLength(1);
});

it("is unavailable until connected and while input is locked", () => {
  const offline = render(<ControlScreen link={fixture(false).link} />);
  expect(screen.getByRole("button", { name: "Right click" })).toBeDisabled();
  offline.unmount();
  render(<ControlScreen link={fixture().link} />);
  const button = screen.getByRole("button", { name: "Right click" });
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("button", { name: "Lock remote input" }));
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-pressed", "false");
});
