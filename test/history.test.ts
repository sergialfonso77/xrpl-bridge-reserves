import { describe, it, expect } from "vitest";
import { verifiedAccountTx, xrpBalanceChange, HistoryGapError, type HistorySource } from "../src/history.js";
import { GATEWAY } from "./helpers.js";

/** Account root change in the shape of a tx's meta. `prev` undefined => CreatedNode. */
const rootNode = (account: string, balance: bigint, prev?: bigint) =>
  prev === undefined
    ? { CreatedNode: { LedgerEntryType: "AccountRoot", NewFields: { Account: account, Balance: balance.toString() } } }
    : { ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: account, Balance: balance.toString() }, PreviousFields: { Balance: prev.toString() } } };

const entry = (hash: string, ledger: number, nodes: unknown[]) => ({
  hash, ledger_index: ledger, validated: true, tx_json: { TransactionType: "Payment" }, meta: { TransactionResult: "tesSUCCESS", AffectedNodes: nodes },
});

interface Tx { hash: string; ledger: number; delta: bigint }

/** In-memory ledger. `dropOnAttempt(hash, attempt)` simulates a node that silently omits rows. */
function fakeSource(txs: Tx[], dropOnAttempt: (hash: string, attempt: number) => boolean = () => false, pageSize = 2) {
  const calls = { pages: 0, attempts: [] as number[] };
  const bal = (ledger: number) => txs.filter((t) => t.ledger <= ledger).reduce((a, t) => a + t.delta, 0n);
  const src: HistorySource = {
    balanceAt: async (_a, ledger) => bal(ledger),
    accountTxPage: async (_a, min, max, marker, attempt) => {
      calls.pages++;
      calls.attempts.push(attempt);
      const rows = txs.filter((t) => t.ledger >= min && t.ledger <= max && !dropOnAttempt(t.hash, attempt));
      const from = typeof marker === "number" ? marker : 0;
      const page = rows.slice(from, from + pageSize);
      const prev = (t: Tx) => bal(t.ledger) - t.delta;
      return {
        transactions: page.map((t) => entry(t.hash, t.ledger, [rootNode(GATEWAY, prev(t) + t.delta, prev(t)), rootNode("rOtherXXXXXXXXXXXXXXXXXXXXXXXXXX", 5n, 9n)])),
        marker: from + pageSize < rows.length ? from + pageSize : undefined,
      };
    },
  };
  return { src, calls };
}

const history = [
  { hash: "A", ledger: 100, delta: 1_000_000n },
  { hash: "B", ledger: 120, delta: -250_000n },
  { hash: "C", ledger: 150, delta: 5_000_000n },
  { hash: "D", ledger: 210, delta: -10n },
  { hash: "E", ledger: 290, delta: 42n },
];

const collect = async (src: HistorySource, opts = {}) => {
  const out: string[] = [];
  for await (const e of verifiedAccountTx(src, GATEWAY, { ledgerMin: 100, ledgerMax: 299, windowSize: 100, ...opts })) out.push(e.hash);
  return out;
};

describe("xrpBalanceChange", () => {
  it("reads modified and created account roots of the given account only", () => {
    const meta = { AffectedNodes: [rootNode(GATEWAY, 1_500n, 1_000n), rootNode("rOtherXXXXXXXXXXXXXXXXXXXXXXXXXX", 1n, 99n)] };
    expect(xrpBalanceChange(meta, GATEWAY)).toBe(500n);
    expect(xrpBalanceChange({ AffectedNodes: [rootNode(GATEWAY, 200_000_000n)] }, GATEWAY)).toBe(200_000_000n);
  });
  it("is zero when the balance did not change or the meta is missing", () => {
    expect(xrpBalanceChange({ AffectedNodes: [{ ModifiedNode: { LedgerEntryType: "AccountRoot", FinalFields: { Account: GATEWAY, Balance: "5" }, PreviousFields: { Sequence: 1 } } }] }, GATEWAY)).toBe(0n);
    expect(xrpBalanceChange(undefined, GATEWAY)).toBe(0n);
  });
});

describe("verifiedAccountTx", () => {
  it("returns everything in order, across pages and windows, when the node is complete", async () => {
    const { src, calls } = fakeSource(history);
    expect(await collect(src)).toEqual(["A", "B", "C", "D", "E"]);
    expect(new Set(calls.attempts)).toEqual(new Set([0]));
  });

  it("refetches a window from another attempt when a row was silently dropped", async () => {
    const { src, calls } = fakeSource(history, (h, attempt) => h === "B" && attempt === 0);
    const seen: number[] = [];
    const out = await collect(src, { onWindow: (w: { attempts: number }) => seen.push(w.attempts) });
    expect(out).toEqual(["A", "B", "C", "D", "E"]);
    expect(seen).toEqual([2, 1]); // windows 100..199 (retried once) and 200..299
    expect(Math.max(...calls.attempts)).toBe(1);
  });

  it("recovers when several attempts in a row are incomplete", async () => {
    const { src } = fakeSource(history, (h, attempt) => h === "D" && attempt < 3);
    expect(await collect(src)).toContain("D");
  });

  it("fails closed with the gap instead of returning incomplete data", async () => {
    const { src } = fakeSource(history, (h) => h === "C");
    const err = await collect(src).catch((e) => e);
    expect(err).toBeInstanceOf(HistoryGapError);
    expect(err.gapDrops).toBe(5_000_000n);
    expect(err.ledgerMin).toBe(100);
  });

  it("does not yield rows of a window that never balanced", async () => {
    const { src } = fakeSource(history, (h) => h === "E");
    const got: string[] = [];
    await expect((async () => { for await (const e of verifiedAccountTx(src, GATEWAY, { ledgerMin: 100, ledgerMax: 299, windowSize: 100 })) got.push(e.hash); })()).rejects.toThrow(HistoryGapError);
    expect(got).toEqual(["A", "B", "C"]); // the first window was verified and delivered; the second is all-or-nothing
  });

  it("deduplicates a row returned twice by overlapping pages", async () => {
    const { src } = fakeSource(history);
    const dup: HistorySource = {
      balanceAt: src.balanceAt,
      accountTxPage: async (a, min, max, marker, attempt) => {
        const p = await src.accountTxPage(a, min, max, marker, attempt);
        return { ...p, transactions: [...p.transactions, ...p.transactions] };
      },
    };
    expect(await collect(dup)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("treats the balance before the first ledger as the starting point", async () => {
    const { src } = fakeSource(history);
    const out: string[] = [];
    for await (const e of verifiedAccountTx(src, GATEWAY, { ledgerMin: 121, ledgerMax: 299, windowSize: 1000 })) out.push(e.hash);
    expect(out).toEqual(["C", "D", "E"]);
  });
});
