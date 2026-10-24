import { describe, it, expect } from "vitest";
import { diffSignerLists, minSignersForQuorum } from "../src/signers.js";
import { parseSignerList } from "../src/xrpl.js";

const list = (quorum: number, weights: number[]) => ({
  quorum,
  entries: weights.map((w, i) => ({ account: `rSigner${i}`, weight: w })),
});

describe("signer list monitoring", () => {
  it("computes the minimum signers to reach quorum", () => {
    expect(minSignersForQuorum(list(20, Array(30).fill(1)))).toBe(20);
    expect(minSignersForQuorum(list(10, [8, 1, 1, 1]))).toBe(3);
    expect(minSignersForQuorum(list(100, [1, 1]))).toBeNull();
  });

  it("reports no alerts when nothing changed", () => {
    expect(diffSignerLists(list(3, [1, 1, 1, 1]), list(3, [1, 1, 1, 1]))).toEqual([]);
  });

  it("raises critical on lowered quorum", () => {
    const a = diffSignerLists(list(3, [1, 1, 1, 1]), list(2, [1, 1, 1, 1]));
    expect(a.some((x) => x.severity === "critical" && x.message.includes("Quorum"))).toBe(true);
  });

  it("raises critical when weight concentration lowers the signers needed", () => {
    const a = diffSignerLists(list(3, [1, 1, 1, 1]), list(3, [3, 1, 1, 1]));
    expect(a.map((x) => x.message).join("|")).toMatch(/Fewer signers now needed to move funds: 3 -> 1/);
  });

  it("reports added and removed signers", () => {
    const prev = list(2, [1, 1, 1]);
    const curr = { quorum: 2, entries: [{ account: "rSigner0", weight: 1 }, { account: "rSigner1", weight: 1 }, { account: "rNew", weight: 1 }] };
    const msgs = diffSignerLists(prev, curr).map((x) => x.message);
    expect(msgs).toContain("Signer added rNew (weight 1)");
    expect(msgs).toContain("Signer removed rSigner2");
  });

  it("raises critical when the signer list disappears", () => {
    expect(diffSignerLists(list(1, [1]), null)[0]!.severity).toBe("critical");
  });

  it("parses the raw ledger SignerList object", () => {
    const raw = { SignerQuorum: 2, SignerEntries: [{ SignerEntry: { Account: "rA", SignerWeight: 1 } }, { SignerEntry: { Account: "rB", SignerWeight: 1 } }] };
    expect(parseSignerList(raw)).toEqual({ quorum: 2, entries: [{ account: "rA", weight: 1 }, { account: "rB", weight: 1 }] });
  });
});
