import { afterEach, describe, expect, it } from "vitest";
import { describeIcePath, monoNow } from "./cloud";
import { mainThreadStats, noteLongTask, resetMainThreadStats } from "./mainThreadMonitor";

describe("describeIcePath", () => {
  it("names a direct LAN path with protocol and network", () => {
    expect(
      describeIcePath(
        { candidateType: "host", protocol: "udp", networkType: "wifi" },
        { candidateType: "host", protocol: "udp" },
      ),
    ).toBe("host·udp·wifi");
  });

  it("flags any relayed leg as relay and reports the relay protocol", () => {
    expect(
      describeIcePath(
        { candidateType: "relay", protocol: "udp", relayProtocol: "tcp", networkType: "cellular" },
        { candidateType: "srflx", protocol: "udp" },
      ),
    ).toBe("relay·tcp·cellular");
    expect(describeIcePath({ candidateType: "srflx", protocol: "udp" }, { candidateType: "relay" })).toBe("relay·udp");
  });

  it("shows mixed NAT types and handles missing stats", () => {
    expect(describeIcePath({ candidateType: "srflx", protocol: "udp" }, { candidateType: "prflx" })).toBe("srflx/prflx·udp");
    expect(describeIcePath(null, null)).toBe("");
    expect(describeIcePath({ candidateType: "host", networkType: "unknown" }, undefined)).toBe("host/?");
  });
});

describe("monoNow", () => {
  it("is epoch-scaled and never goes backwards", () => {
    const a = monoNow();
    const b = monoNow();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(Math.abs(a - Date.now())).toBeLessThan(60_000);
  });
});

describe("mainThreadMonitor", () => {
  afterEach(() => resetMainThreadStats());

  it("counts long tasks in a sliding 10s window", () => {
    noteLongTask(1000, 60);
    noteLongTask(5000, 180);
    expect(mainThreadStats(6000)).toEqual({ count: 2, totalMs: 240, maxMs: 180 });
    // 12s later the first has aged out, the second (ended at 5180) too by 15.2s.
    expect(mainThreadStats(12_000)).toEqual({ count: 1, totalMs: 180, maxMs: 180 });
    expect(mainThreadStats(16_000)).toEqual({ count: 0, totalMs: 0, maxMs: 0 });
  });
});
