// Minimal XRPL JSON-RPC client (no dependencies). Only reads validated data.
import type { HistorySource } from "./history.js";

export interface SignerEntry {
  account: string;
  weight: number;
}

export interface SignerList {
  quorum: number;
  entries: SignerEntry[];
}

export interface AccountSnapshot {
  account: string;
  ledgerIndex: number;
  balanceDrops: bigint;
  ownerCount: number;
  signerList: SignerList | null;
}

/** The node answered, but with an error (e.g. actNotFound): deterministic, retrying the same query will not help. */
class RpcError extends Error {}

export interface XrplClientOptions {
  /** Passes over the endpoint list before giving up on transport failures (timeouts, HTTP 5xx, DNS). */
  rounds?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export class XrplClient implements HistorySource {
  private readonly rounds: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly endpoints: string[], opts: XrplClientOptions = {}) {
    if (endpoints.length === 0) throw new Error("At least one XRPL endpoint is required");
    this.rounds = opts.rounds ?? 3;
    this.backoffMs = opts.backoffMs ?? 1_000;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Tries every endpoint, starting at `startAt` (mod endpoint count) so retries can hit another node.
   * Transport failures are retried with backoff; if every endpoint answered with an RPC error it throws at once.
   */
  async request<T = any>(method: string, params: Record<string, unknown>, startAt = 0): Promise<T> {
    let lastError: unknown;
    for (let round = 0; round < this.rounds; round++) {
      let transportFailure = false;
      for (let i = 0; i < this.endpoints.length; i++) {
        const url = this.endpoints[(startAt + i) % this.endpoints.length]!;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ method, params: [params] }),
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
          const body: any = await res.json();
          if (body?.result?.status === "error") {
            throw new RpcError(`${method}: ${body.result.error} ${body.result.error_message ?? ""}`.trim());
          }
          return body.result as T;
        } catch (err) {
          lastError = err;
          if (!(err instanceof RpcError)) transportFailure = true;
        }
      }
      if (!transportFailure) break;
      if (round < this.rounds - 1) await new Promise((r) => setTimeout(r, this.backoffMs * (round + 1)));
    }
    throw lastError;
  }

  async accountSnapshot(account: string): Promise<AccountSnapshot> {
    const info: any = await this.request("account_info", {
      account,
      ledger_index: "validated",
      signer_lists: true,
    });
    if (info.validated !== true) throw new Error("account_info did not return validated data");
    const data = info.account_data;
    // API v1 returns signer_lists inside account_data; API v2 at the result root.
    const rawLists: any[] = info.signer_lists ?? data.signer_lists ?? [];
    return {
      account,
      ledgerIndex: info.ledger_index,
      balanceDrops: BigInt(data.Balance),
      ownerCount: data.OwnerCount,
      signerList: rawLists[0] ? parseSignerList(rawLists[0]) : null,
    };
  }

  /** Base + owner reserve currently locked by the ledger (not spendable, but still held). */
  async reserves(): Promise<{ baseDrops: bigint; incrementDrops: bigint }> {
    const r: any = await this.request("server_state", {});
    const l = r.state.validated_ledger;
    return { baseDrops: BigInt(l.reserve_base), incrementDrops: BigInt(l.reserve_inc) };
  }

  /** Index of the latest validated ledger. */
  async validatedLedger(): Promise<number> {
    const r: any = await this.request("ledger", { ledger_index: "validated" });
    if (r.validated !== true) throw new Error("ledger did not return validated data");
    return Number(r.ledger_index);
  }

  async balanceAt(account: string, ledger: number): Promise<bigint> {
    try {
      const r: any = await this.request("account_info", { account, ledger_index: ledger });
      if (r.validated !== true) throw new Error(`account_info at ledger ${ledger} did not return validated data`);
      return BigInt(r.account_data.Balance);
    } catch (e) {
      if (String(e).includes("actNotFound")) return 0n; // not created yet at that ledger
      throw e;
    }
  }

  /** One page of account_tx (oldest first) within [min, max]. Use `verifiedAccountTx` from history.ts, never loop on this alone. */
  async accountTxPage(account: string, min: number, max: number, marker: unknown, attempt: number) {
    return this.request<{ transactions: any[]; marker?: unknown }>(
      "account_tx",
      { account, ledger_index_min: min, ledger_index_max: max, forward: true, limit: 100, ...(marker ? { marker } : {}) },
      attempt,
    );
  }
}

export function parseSignerList(obj: any): SignerList {
  return {
    quorum: Number(obj.SignerQuorum),
    entries: (obj.SignerEntries ?? []).map((e: any) => ({
      account: e.SignerEntry.Account,
      weight: Number(e.SignerEntry.SignerWeight),
    })),
  };
}
