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
}
