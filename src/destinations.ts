// Measure the XRP outstanding on every destination chain that holds the bridged-XRP ITS token.
//
// Destinations are enumerated from the Axelar ITS Hub (not from a hardcoded list), so a newly
// added chain cannot silently escape the sum: if the Hub tracks its supply we use that, otherwise
// we need an on-chain measurer for it, and without one the chain is reported as `unmeasured`.
import type { OutstandingSource } from "./reserves.js";

export type JsonFetcher = (url: string, init?: RequestInit) => Promise<any>;

export const fetchJson: JsonFetcher = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

export interface DestinationConfig {
  axelar: { rest: string[]; itsHub: string; originChain: string; xrpTokenId: string };
  xrplEvm: { axelarChainName: string; cosmosRest: string[]; nativeDenom: string };
  hedera: { mirror: string; wxrpToken: string };
}

export interface Alert {
  chain: string;
  message: string;
}

export interface DestinationMeasurement {
  outstanding: OutstandingSource[];
  unmeasured: string[]; // chains holding the token with no tracked supply and no on-chain measurer
  alerts: Alert[];
}

const DROP_DECIMALS = 6;

/** Rescale an integer amount to drops. Rounds UP when precision is lost: liabilities are never understated. */
export function scaleToDrops(amount: bigint, decimals: number): bigint {
  if (decimals === DROP_DECIMALS) return amount;
  if (decimals < DROP_DECIMALS) return amount * 10n ** BigInt(DROP_DECIMALS - decimals);
  const div = 10n ** BigInt(decimals - DROP_DECIMALS);
  return (amount + div - 1n) / div;
}

function parseUint(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${what}: expected unsigned integer string, got ${JSON.stringify(value)}`);
  return BigInt(value);
}

async function firstOk<T>(bases: string[], path: string, f: JsonFetcher): Promise<T> {
  let last: unknown;
  for (const base of bases) {
    try {
      return await f(base.replace(/\/$/, "") + path);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Smart query against the ITS Hub CosmWasm contract. */
async function hubQuery<T>(cfg: DestinationConfig["axelar"], msg: unknown, f: JsonFetcher): Promise<T> {
  const b64 = Buffer.from(JSON.stringify(msg)).toString("base64");
  const body = await firstOk<{ data: T }>(cfg.rest, `/cosmwasm/wasm/v1/contract/${cfg.itsHub}/smart/${b64}`, f);
  return body.data;
}

async function hubChains(cfg: DestinationConfig["axelar"], f: JsonFetcher): Promise<string[]> {
  const limit = 100;
  const chains: string[] = [];
  for (;;) {
    const page = await hubQuery<{ chain: string }[]>(
      cfg,
      { its_chains: { filter: null, start_after: chains.at(-1) ?? null, limit } },
      f,
    );
    chains.push(...page.map((c) => c.chain));
    if (page.length < limit) return chains;
  }
}

interface TokenInstance {
  supply: "untracked" | { tracked: string };
  decimals: number;
}

/** Native XRP supply on XRPL EVM = Cosmos bank supply of `axrp` (18 decimals), not reachable over eth_*. */
export async function xrplEvmNativeSupply(cfg: DestinationConfig["xrplEvm"], f: JsonFetcher): Promise<bigint> {
  const body = await firstOk<any>(cfg.cosmosRest, `/cosmos/bank/v1beta1/supply/by_denom?denom=${cfg.nativeDenom}`, f);
  if (body?.amount?.denom !== cfg.nativeDenom) throw new Error(`bank supply: unexpected denom ${body?.amount?.denom}`);
  return parseUint(body.amount.amount, "bank supply");
}

/** wXRP (HTS token) total supply in drops, from the Hedera mirror node. */
export async function hederaWxrpSupply(cfg: DestinationConfig["hedera"], f: JsonFetcher): Promise<bigint> {
  const body = await f(`${cfg.mirror.replace(/\/$/, "")}/api/v1/tokens/${cfg.wxrpToken}`);
  if (body?.symbol !== "wXRP") throw new Error(`hedera token ${cfg.wxrpToken}: unexpected symbol ${body?.symbol}`);
  return scaleToDrops(parseUint(body.total_supply, "hedera total_supply"), Number(body.decimals));
}

export async function measureOutstanding(cfg: DestinationConfig, f: JsonFetcher = fetchJson): Promise<DestinationMeasurement> {
  const outstanding: OutstandingSource[] = [];
  const unmeasured: string[] = [];
  const alerts: Alert[] = [];

  const onChain: Record<string, () => Promise<{ drops: bigint; method: string }>> = {
    [cfg.xrplEvm.axelarChainName]: async () => ({
      drops: scaleToDrops(await xrplEvmNativeSupply(cfg.xrplEvm, f), 18),
      method: `cosmos bank supply of ${cfg.xrplEvm.nativeDenom}`,
    }),
    hedera: async () => ({ drops: await hederaWxrpSupply(cfg.hedera, f), method: `hedera mirror node total_supply of ${cfg.hedera.wxrpToken}` }),
  };

  for (const chain of await hubChains(cfg.axelar, f)) {
    if (chain === cfg.axelar.originChain) continue; // XRP is locked there, not outstanding
    const inst = await hubQuery<TokenInstance | null>(cfg.axelar, { token_instance: { chain, token_id: cfg.axelar.xrpTokenId } }, f);
    if (!inst) continue;

    const measure = onChain[chain];
    const measured = measure ? await measure() : null;
    if (inst.supply === "untracked") {
      if (!measured) unmeasured.push(chain);
      else outstanding.push({ chain, method: measured.method, drops: measured.drops });
      continue;
    }
    // Tracked: the Hub caps what can leave this chain, so it is the redeemable liability. If the chain
    // itself holds more than the Hub knows about, take the larger figure and raise an alert.
    const tracked = scaleToDrops(parseUint(inst.supply.tracked, "its hub tracked supply"), inst.decimals);
    if (measured && measured.drops > tracked) {
      alerts.push({ chain, message: `on-chain supply ${measured.drops} drops exceeds ITS Hub tracked supply ${tracked} drops` });
      outstanding.push({ chain, method: `${measured.method} (exceeds hub tracked ${tracked})`, drops: measured.drops });
    } else {
      outstanding.push({ chain, method: "its hub tracked supply", drops: tracked });
    }
  }
  return { outstanding, unmeasured, alerts };
}
