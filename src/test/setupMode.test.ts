import { describe, expect, it } from "vitest";
import { readRemoteOnly, routeAllowed, tabAllowed, REMOTE_ONLY_KEY } from "@/lib/setupMode";

describe("setup mode", () => {
  describe("readRemoteOnly", () => {
    it("is off unless the setting is exactly 'true'", () => {
      expect(readRemoteOnly({ [REMOTE_ONLY_KEY]: "true" })).toBe(true);
      expect(readRemoteOnly({ [REMOTE_ONLY_KEY]: "false" })).toBe(false);
      expect(readRemoteOnly({})).toBe(false);
    });

    // Settings load async on every client — an unknown mode must not blank the UI.
    it("treats missing settings as the full app", () => {
      expect(readRemoteOnly(undefined)).toBe(false);
      expect(readRemoteOnly(null)).toBe(false);
    });
  });

  describe("routeAllowed", () => {
    it("allows every route when remote-only is off", () => {
      for (const path of ["/", "/library", "/music", "/game/abc", "/remote", "/settings"]) {
        expect(routeAllowed(path, false)).toBe(true);
      }
    });

    it("keeps only Remote and Settings when remote-only is on", () => {
      expect(routeAllowed("/remote", true)).toBe(true);
      expect(routeAllowed("/settings", true)).toBe(true);
      for (const path of ["/", "/library", "/apps", "/system", "/timeline", "/music", "/collection", "/suggested", "/tags"]) {
        expect(routeAllowed(path, true)).toBe(false);
      }
    });

    it("blocks game detail, which is reachable by deep link rather than nav", () => {
      expect(routeAllowed("/game/some-id", true)).toBe(false);
    });

    // "/remotely" must not slip through a naive prefix check.
    it("matches whole path segments, not string prefixes", () => {
      expect(routeAllowed("/remotely", true)).toBe(false);
      expect(routeAllowed("/settings-old", true)).toBe(false);
      expect(routeAllowed("/remote/monitor", true)).toBe(true);
    });
  });

  describe("tabAllowed", () => {
    it("keeps every companion tab when remote-only is off", () => {
      for (const tab of ["stats", "library", "timeline", "collection", "music", "control", "system", "settings"]) {
        expect(tabAllowed(tab, false)).toBe(true);
      }
    });

    it("keeps only Remote and Settings when remote-only is on", () => {
      expect(tabAllowed("control", true)).toBe(true);
      expect(tabAllowed("settings", true)).toBe(true);
      for (const tab of ["stats", "library", "timeline", "collection", "music", "system"]) {
        expect(tabAllowed(tab, true)).toBe(false);
      }
    });
  });
});
