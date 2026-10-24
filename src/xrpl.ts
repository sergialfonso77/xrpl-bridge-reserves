// Minimal XRPL JSON-RPC client (no dependencies). Only reads validated data.

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

export class XrplClient {
  constructor(private readonly endpoints: string[]) {
    if (endpoints.length === 0) throw new Error("At least one XRPL endpoint is required");
  }

  async request<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    let lastError: unknown;
    for (const url of this.endpoints) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method, params: [params] }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
        const body: any = await res.json();
        if (body?.result?.status === "error") {
          throw new Error(`${method}: ${body.result.error} ${body.result.error_message ?? ""}`.trim());
        }
        return body.result as T;
      } catch (err) {
        lastError = err;
      }
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

  /** Page through validated transactions of an account. */
  async *accountTx(account: string, opts: { ledgerMin?: number; ledgerMax?: number } = {}) {
    let marker: unknown = undefined;
    do {
      const r: any = await this.request("account_tx", {
        account,
        ledger_index_min: opts.ledgerMin ?? -1,
        ledger_index_max: opts.ledgerMax ?? -1,
        forward: true,
        limit: 200,
        ...(marker ? { marker } : {}),
      });
      for (const t of r.transactions ?? []) yield t;
      marker = r.marker;
    } while (marker);
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
