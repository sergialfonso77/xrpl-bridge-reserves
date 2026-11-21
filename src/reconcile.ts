// Event-level reconciliation: every XRPL deposit to the gateway vs the mint it should cause on the destination.
//
// The destination event carries the original sender (sourceAddress = XRPL r-address), the recipient and the exact
// amount, so a deposit and its mint can be paired from on-chain data alone (no third-party index). Pairs are made
// causally per (sender, recipient, amount): a mint is paired with the OLDEST still-pending deposit with the same
// key that happened no later than the mint (plus a small clock tolerance). Whatever stays pending is an unmatched
// deposit (stuck, in flight or never delivered); a mint with nothing pending is an orphan.
import type { Mint } from "./evmlogs.js";

/** XRP has 6 decimals on the XRPL and 18 on XRPL EVM. */
export const WEI_PER_DROP = 1_000_000_000_000n;

export interface Deposit {
  hash: string;
  ledger: number;
  time: number; // unix seconds of the ledger close
  sender: string; // XRPL r-address
  destinationAddress: string; // lowercase 0x… (from the memo)
  netDrops: bigint; // delivered_amount − gas_fee_amount: what should be minted
}

export interface Match {
  deposit: Deposit;
  mint: Mint;
  delaySeconds: number;
}

export interface Reconciliation {
  matched: Match[];
  unmatchedDeposits: Deposit[];
  orphanMints: Mint[];
}

const key = (sender: string, to: string, wei: bigint) => `${sender}|${to.toLowerCase()}|${wei}`;

export function reconcile(deposits: Deposit[], mints: Mint[], opts: { clockToleranceSeconds?: number } = {}): Reconciliation {
  const tolerance = opts.clockToleranceSeconds ?? 120;
  type Ev = { t: number; kind: 0 | 1; i: number }; // deposits sort before mints at equal time
  const events: Ev[] = [
    ...deposits.map((d, i): Ev => ({ t: d.time, kind: 0, i })),
    ...mints.map((m, i): Ev => ({ t: m.time + tolerance, kind: 1, i })),
  ].sort((a, b) => a.t - b.t || a.kind - b.kind || a.i - b.i);

  const pending = new Map<string, Deposit[]>();
  const matched: Match[] = [];
  const orphanMints: Mint[] = [];

  for (const ev of events) {
    if (ev.kind === 0) {
      const d = deposits[ev.i]!;
      const k = key(d.sender, d.destinationAddress, d.netDrops * WEI_PER_DROP);
      (pending.get(k) ?? pending.set(k, []).get(k)!).push(d);
    } else {
      const m = mints[ev.i]!;
      const q = pending.get(key(m.sourceAddress, m.destinationAddress, m.amountWei));
      const d = q?.shift();
      if (d) matched.push({ deposit: d, mint: m, delaySeconds: m.time - d.time });
      else orphanMints.push(m);
    }
  }
  const unmatchedDeposits = [...pending.values()].flat().sort((a, b) => a.ledger - b.ledger);
  return { matched, unmatchedDeposits, orphanMints };
}

export interface ReconciliationSummary {
  deposits: number;
  mints: number;
  matched: number;
  unmatchedDeposits: number;
  unmatchedDrops: bigint;
  orphanMints: number;
  orphanDrops: bigint; // rounded down to drops
  delaySeconds: { median: number; p95: number; max: number } | null;
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

export function summarise(r: Reconciliation, depositCount: number, mintCount: number): ReconciliationSummary {
  const delays = r.matched.map((m) => m.delaySeconds).sort((a, b) => a - b);
  return {
    deposits: depositCount,
    mints: mintCount,
    matched: r.matched.length,
    unmatchedDeposits: r.unmatchedDeposits.length,
    unmatchedDrops: r.unmatchedDeposits.reduce((a, d) => a + d.netDrops, 0n),
    orphanMints: r.orphanMints.length,
    orphanDrops: r.orphanMints.reduce((a, m) => a + m.amountWei, 0n) / WEI_PER_DROP,
    delaySeconds: delays.length ? { median: quantile(delays, 0.5), p95: quantile(delays, 0.95), max: delays.at(-1)! } : null,
  };
}
