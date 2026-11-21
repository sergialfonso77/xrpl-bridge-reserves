// Minimal EVM JSON-RPC client for the XRPL EVM.

export class EvmClient {
  constructor(private readonly url: string) {}

  async call<T = any>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`EVM RPC HTTP ${res.status}`);
    const body: any = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result as T;
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_chainId", [])));
  }

  async blockNumber(): Promise<number> {
    return Number(BigInt(await this.call<string>("eth_blockNumber", [])));
  }

  async balanceWei(address: string, block: string = "latest"): Promise<bigint> {
    return BigInt(await this.call<string>("eth_getBalance", [address, block]));
  }

  /** ERC-20 totalSupply() of a token contract. */
  async erc20TotalSupply(token: string, block: string = "latest"): Promise<bigint> {
    const data = "0x18160ddd"; // totalSupply()
    return BigInt(await this.call<string>("eth_call", [{ to: token, data }, block]));
  }

  /** eth_getLogs over [fromBlock, toBlock] (the XRPL EVM RPC allows at most 10,000 blocks per call). */
  async getLogs(filter: { address: string; topics: (string | null)[]; fromBlock: number; toBlock: number }): Promise<EvmLog[]> {
    return this.call<EvmLog[]>("eth_getLogs", [
      { address: filter.address, topics: filter.topics, fromBlock: "0x" + filter.fromBlock.toString(16), toBlock: "0x" + filter.toBlock.toString(16) },
    ]);
  }

  /**
   * Unix seconds of a block. The public RPC load-balances over nodes that do not all hold old blocks, so a `null`
   * is retried a few times before the block is declared missing.
   */
  async blockTimestamp(block: number, attempts = 12): Promise<number> {
    for (let i = 1; ; i++) {
      const b = await this.call<{ timestamp: string } | null>("eth_getBlockByNumber", ["0x" + block.toString(16), false]);
      if (b) return Number(BigInt(b.timestamp));
      if (i >= attempts) throw new Error(`block ${block} not found after ${attempts} attempts`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** First block whose timestamp is >= `unixSeconds` (clamped to `latest`). Binary search over block timestamps. */
  async blockAtOrAfter(unixSeconds: number, latest: number): Promise<number> {
    let lo = 0, hi = latest;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await this.blockTimestamp(mid)) >= unixSeconds) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}
