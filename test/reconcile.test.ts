import { describe, it, expect } from "vitest";
import { reconcile, summarise, WEI_PER_DROP, type Deposit } from "../src/reconcile.js";
import type { Mint } from "../src/evmlogs.js";

const R1 = "rSender1XXXXXXXXXXXXXXXXXXXXXXXXXX";
const R2 = "rSender2XXXXXXXXXXXXXXXXXXXXXXXXXX";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

const dep = (hash: string, time: number, sender = R1, to = A, netDrops = 5_000_000n): Deposit => ({ hash, ledger: time, time, sender, destinationAddress: to, netDrops });
const mint = (id: string, time: number, sender = R1, to = A, drops = 5_000_000n): Mint => ({
  block: time, time, tx: "0x" + id, logIndex: 0, commandId: "0x" + id, sourceChain: "xrpl", sourceAddress: sender, destinationAddress: to, amountWei: drops * WEI_PER_DROP,
});

describe("reconcile", () => {
  it("pairs a deposit with its mint and reports the delay", () => {
    const r = reconcile([dep("D1", 1000)], [mint("m1", 1045)]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.delaySeconds).toBe(45);
    expect(r.unmatchedDeposits).toEqual([]);
    expect(r.orphanMints).toEqual([]);
  });

  it("leaves a deposit without a mint as unmatched and a mint without a deposit as orphan", () => {
    const r = reconcile([dep("D1", 1000), dep("D2", 1100, R2, B, 7_000_000n)], [mint("m1", 1050), mint("mX", 1200, R2, B, 9_000_000n)]);
    expect(r.matched.map((m) => m.deposit.hash)).toEqual(["D1"]);
    expect(r.unmatchedDeposits.map((d) => d.hash)).toEqual(["D2"]);
    expect(r.orphanMints.map((m) => m.commandId)).toEqual(["0xmX"]);
  });

  it("requires the exact amount, recipient and sender", () => {
    const r = reconcile([dep("D1", 1000)], [mint("a", 1050, R1, A, 5_000_001n), mint("b", 1050, R1, B), mint("c", 1050, R2, A)]);
    expect(r.matched).toEqual([]);
    expect(r.unmatchedDeposits).toHaveLength(1);
    expect(r.orphanMints).toHaveLength(3);
  });

  it("compares recipients case-insensitively", () => {
    expect(reconcile([dep("D1", 1000, R1, A.toUpperCase().replace("0X", "0x"))], [mint("m1", 1010)]).matched).toHaveLength(1);
  });

  it("pairs repeated identical transfers oldest-first and flags the extra deposit", () => {
    const r = reconcile([dep("D1", 1000), dep("D2", 2000), dep("D3", 3000)], [mint("m1", 1010), mint("m2", 2010)]);
    expect(r.matched.map((m) => [m.deposit.hash, m.mint.commandId])).toEqual([["D1", "0xm1"], ["D2", "0xm2"]]);
    expect(r.unmatchedDeposits.map((d) => d.hash)).toEqual(["D3"]);
  });

  it("does not pair a mint with a deposit that happened clearly after it", () => {
    const r = reconcile([dep("D1", 2000)], [mint("m1", 1000)]);
    expect(r.matched).toEqual([]);
    expect(r.orphanMints).toHaveLength(1);
    expect(r.unmatchedDeposits).toHaveLength(1);
  });

  it("tolerates a few seconds of clock skew between the two chains", () => {
    expect(reconcile([dep("D1", 1000)], [mint("m1", 950)]).matched).toHaveLength(1); // mint 50 s "before" the deposit
    expect(reconcile([dep("D1", 1000)], [mint("m1", 800)], { clockToleranceSeconds: 120 }).matched).toHaveLength(0);
  });

  it("is order independent for its inputs", () => {
    const d = [dep("D1", 1000), dep("D2", 1500, R2, B)], m = [mint("m1", 1040), mint("m2", 1600, R2, B)];
    const a = reconcile(d, m), b = reconcile([...d].reverse(), [...m].reverse());
    expect(b.matched.map((x) => x.deposit.hash).sort()).toEqual(a.matched.map((x) => x.deposit.hash).sort());
  });
});

describe("summarise", () => {
  it("counts, sums the unmatched/orphan XRP in drops and gives delay quantiles", () => {
    const r = reconcile(
      [dep("D1", 1000), dep("D2", 1000, R2, B, 2_000_000n), dep("D3", 1000, R1, B, 3_000_000n)],
      [mint("m1", 1010), mint("m2", 1100, R2, B, 2_000_000n), mint("mX", 1200, R1, A, 4_000_000n)],
    );
    const s = summarise(r, 3, 3);
    expect(s).toMatchObject({ deposits: 3, mints: 3, matched: 2, unmatchedDeposits: 1, unmatchedDrops: 3_000_000n, orphanMints: 1, orphanDrops: 4_000_000n });
    expect(s.delaySeconds).toEqual({ median: 100, p95: 100, max: 100 });
  });
  it("has no delay stats without matches", () => {
    expect(summarise({ matched: [], unmatchedDeposits: [], orphanMints: [] }, 0, 0).delaySeconds).toBeNull();
  });
});
