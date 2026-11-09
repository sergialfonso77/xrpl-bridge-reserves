// Gap-checked account history.
//
// account_tx served by public XRPL clusters can silently drop transactions between pages (a 999 XRP
// payment went missing in a 5.8M-tx scan). A missing deposit or release would make every downstream
// number wrong without any error, so history is only accepted window by window: the sum of the
// account's XRP balance changes in a window's transactions must equal the difference of the
// account's real balance at the window edges. A window that does not balance is refetched, from a
// different endpoint, and if it still does not balance we fail instead of returning partial data.
//
// Limit: a dropped transaction that did not move the account's XRP balance (e.g. an IOU payment
// between third parties, a failed tx paid by someone else) cannot be detected by this check.

export interface HistorySource {
  /** XRP balance in drops at a validated ledger; 0n if the account did not exist yet. */
  balanceAt(account: string, ledger: number): Promise<bigint>;
  /** One account_tx page limited to [min, max]. `attempt` lets the source rotate endpoints. */
  accountTxPage(account: string, min: number, max: number, marker: unknown, attempt: number): Promise<{ transactions: any[]; marker?: unknown }>;
}

export class HistoryGapError extends Error {
  constructor(
    readonly ledgerMin: number,
    readonly ledgerMax: number,
    readonly gapDrops: bigint,
  ) {
    super(`account_tx window ${ledgerMin}..${ledgerMax} does not balance after retries: gap ${gapDrops} drops`);
  }
}

/** Change of `account`'s XRP balance (drops) recorded in a transaction's metadata. */
export function xrpBalanceChange(meta: any, account: string): bigint {
  let delta = 0n;
  for (const n of meta?.AffectedNodes ?? []) {
    const node = n.CreatedNode ?? n.ModifiedNode ?? n.DeletedNode;
    if (node?.LedgerEntryType !== "AccountRoot") continue;
    const fields = node.FinalFields ?? node.NewFields;
    if (fields?.Account !== account) continue;
    if (n.CreatedNode) delta += BigInt(node.NewFields.Balance);
    else if (node.PreviousFields?.Balance !== undefined) delta += BigInt(fields.Balance) - BigInt(node.PreviousFields.Balance);
  }
  return delta;
}

const entryHash = (e: any): string => e.hash ?? e.tx_json?.hash ?? e.tx?.hash;

async function fetchWindow(src: HistorySource, account: string, min: number, max: number, attempt: number): Promise<any[]> {
  const byHash = new Map<string, any>();
  let marker: unknown;
  do {
    const page = await src.accountTxPage(account, min, max, marker, attempt);
    for (const e of page.transactions ?? []) byHash.set(entryHash(e), e);
    marker = page.marker;
  } while (marker);
  return [...byHash.values()];
}

export interface VerifiedHistoryOptions {
  ledgerMin: number;
  ledgerMax: number;
  windowSize?: number;
  maxAttempts?: number;
  onWindow?: (info: { ledgerMin: number; ledgerMax: number; entries: number; attempts: number }) => void;
}

/** Yield the account's transactions in ledger order, one balance-verified window at a time. */
export async function* verifiedAccountTx(src: HistorySource, account: string, opts: VerifiedHistoryOptions) {
  const windowSize = opts.windowSize ?? 50_000;
  const maxAttempts = opts.maxAttempts ?? 4;
  let before = await src.balanceAt(account, opts.ledgerMin - 1);
  for (let lo = opts.ledgerMin; lo <= opts.ledgerMax; lo += windowSize) {
    const hi = Math.min(lo + windowSize - 1, opts.ledgerMax);
    const after = await src.balanceAt(account, hi);
    let entries: any[] = [];
    let gap = 0n;
    let attempt = 0;
    for (; attempt < maxAttempts; attempt++) {
      entries = await fetchWindow(src, account, lo, hi, attempt);
      const sum = entries.reduce((a, e) => a + xrpBalanceChange(e.meta, account), 0n);
      gap = after - before - sum;
      if (gap === 0n) break;
    }
    if (gap !== 0n) throw new HistoryGapError(lo, hi, gap);
    opts.onWindow?.({ ledgerMin: lo, ledgerMax: hi, entries: entries.length, attempts: attempt + 1 });
    yield* entries;
    before = after;
  }
}
