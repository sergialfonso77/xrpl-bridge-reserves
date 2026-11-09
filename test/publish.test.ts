import { describe, it, expect } from "vitest";
import { appendHistory, healthProblems, historyPoint, toPublic, type HistoryPoint, type Snapshot } from "../src/publish.js";

const snap = (over: Partial<Snapshot> = {}, report: Partial<Snapshot["report"]> = {}): Snapshot => ({
  takenAt: "2026-11-09T12:00:00.000Z", network: "mainnet", gateway: "rGw", xrplLedger: 100,
  signerList: { quorum: 1223320, entries: new Array(28).fill({}) }, minSignersForQuorum: 19,
  report: {
    gatewayBalanceDrops: "1618562586797", ledgerReserveDrops: "48600000", backingDrops: "1618513986797",
    outstandingDrops: "1610939788991", surplusDrops: "7574197806", collateralRatio: 1.004701, status: "backed", ...report,
  },
  outstanding: [{ chain: "xrpl-evm", method: "m", drops: "1610939788991" }], unmeasured: [], alerts: [], ...over,
});

const pt = (t: string): HistoryPoint => ({ ...historyPoint(snap({ takenAt: t })) });

describe("healthProblems", () => {
  it("is empty for a backed, fully measured report with no alerts", () => {
    expect(healthProblems(snap(), [])).toEqual([]);
  });
  it("flags anything other than backed, unmeasured chains and hub/chain alerts", () => {
    expect(healthProblems(snap({}, { status: "undercollateralised" }), [])).toHaveLength(1);
    expect(healthProblems(snap({}, { status: "unverified" }), [])).toHaveLength(1);
    expect(healthProblems(snap({ unmeasured: ["newchain"] }), [])).toEqual(["unmeasured destination chains: newchain"]);
    expect(healthProblems(snap({ alerts: [{ chain: "hedera", message: "too high" }] }), [])).toEqual(["hedera: too high"]);
  });
  it("treats warning and critical signer alerts as problems but not info", () => {
    expect(healthProblems(snap(), [{ severity: "info", message: "first observed" }])).toEqual([]);
    expect(healthProblems(snap(), [{ severity: "warning", message: "Signer added rX" }, { severity: "critical", message: "Quorum changed" }])).toHaveLength(2);
  });
});

describe("toPublic", () => {
  it("formats XRP amounts, hides signer addresses and carries the problems", () => {
    const pub = toPublic(snap(), [{ severity: "warning", message: "Signer added rX" }]);
    expect(pub.human).toEqual({ gatewayBalanceXrp: "1618562.586797", backingXrp: "1618513.986797", outstandingXrp: "1610939.788991", surplusXrp: "7574.197806" });
    expect(pub.signers).toEqual({ count: 28, quorum: 1223320, minForQuorum: 19 });
    expect(JSON.stringify(pub)).not.toContain("entries");
    expect(pub.problems).toHaveLength(1);
  });
  it("handles an unverified report without a surplus", () => {
    const pub = toPublic(snap({}, { surplusDrops: null, collateralRatio: null, status: "unverified" }), []);
    expect(pub.human.surplusXrp).toBeNull();
  });
});

describe("appendHistory", () => {
  it("appends in time order and replaces a point with the same timestamp", () => {
    const h = appendHistory([pt("2026-11-09T10:00:00.000Z")], pt("2026-11-09T11:00:00.000Z"));
    expect(h.map((p) => p.t)).toEqual(["2026-11-09T10:00:00.000Z", "2026-11-09T11:00:00.000Z"]);
    expect(appendHistory(h, pt("2026-11-09T11:00:00.000Z"))).toHaveLength(2);
  });
  it("keeps full resolution for recent days and one point per day for older ones", () => {
    const old = ["2026-10-01T01:00:00.000Z", "2026-10-01T23:00:00.000Z", "2026-10-02T05:00:00.000Z"].map(pt);
    const recent = ["2026-11-09T01:00:00.000Z", "2026-11-09T02:00:00.000Z"].map(pt);
    const h = appendHistory([...old, ...recent], pt("2026-11-09T12:00:00.000Z"));
    expect(h.map((p) => p.t)).toEqual([
      "2026-10-01T23:00:00.000Z", "2026-10-02T05:00:00.000Z",
      "2026-11-09T01:00:00.000Z", "2026-11-09T02:00:00.000Z", "2026-11-09T12:00:00.000Z",
    ]);
  });
  it("caps the series, dropping the oldest points", () => {
    const base = Array.from({ length: 5 }, (_, i) => pt(`2026-11-09T0${i}:00:00.000Z`));
    const h = appendHistory(base, pt("2026-11-09T09:00:00.000Z"), { maxPoints: 3 });
    expect(h).toHaveLength(3);
    expect(h.at(-1)!.t).toBe("2026-11-09T09:00:00.000Z");
  });
});
