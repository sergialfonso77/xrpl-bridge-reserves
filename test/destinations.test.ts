import { describe, it, expect } from "vitest";
import { measureOutstanding, scaleToDrops, type DestinationConfig, type JsonFetcher } from "../src/destinations.js";

const cfg: DestinationConfig = {
  axelar: { rest: ["https://axelar.test"], itsHub: "axelar1hub", originChain: "xrpl", xrpTokenId: "ab".repeat(32) },
  xrplEvm: { axelarChainName: "xrpl-evm", cosmosRest: ["https://cosmos.test"], nativeDenom: "axrp" },
  hedera: { mirror: "https://mirror.test", wxrpToken: "0.0.1" },
};

type Instance = { supply: "untracked" | { tracked: string }; decimals: number } | null;

/** Fake network: ITS Hub chains/instances, XRPL EVM bank supply (wei) and Hedera wXRP supply. */
function fakeFetcher(o: { instances: Record<string, Instance>; evmWei?: string; hederaSupply?: string; failFirstHub?: boolean }): JsonFetcher {
  let failed = false;
  return async (url) => {
    if (url.startsWith("https://axelar.test/")) {
      if (o.failFirstHub && !failed) { failed = true; throw new Error("boom"); }
      const msg = JSON.parse(Buffer.from(url.split("/smart/")[1]!, "base64").toString());
      if (msg.its_chains) return { data: Object.keys(o.instances).map((chain) => ({ chain })) };
      if (msg.token_instance) {
        expect(msg.token_instance.token_id).toBe(cfg.axelar.xrpTokenId);
        return { data: o.instances[msg.token_instance.chain] ?? null };
      }
    }
    if (url.startsWith("https://cosmos.test/")) return { amount: { denom: "axrp", amount: o.evmWei } };
    if (url.startsWith("https://mirror.test/")) return { symbol: "wXRP", decimals: "6", total_supply: o.hederaSupply };
    throw new Error(`unexpected url ${url}`);
  };
}

describe("scaleToDrops", () => {
  it("rounds up when dropping precision, never understating a liability", () => {
    expect(scaleToDrops(1_000_000_000_000n, 18)).toBe(1n);
    expect(scaleToDrops(1_000_000_000_001n, 18)).toBe(2n);
    expect(scaleToDrops(5n, 6)).toBe(5n);
    expect(scaleToDrops(5n, 2)).toBe(50_000n); // 0.05 XRP
  });
});

describe("measureOutstanding", () => {
  const base = { xrpl: { supply: "untracked", decimals: 6 } as Instance, other: null as Instance };

  it("sums tracked chains from the Hub and untracked chains on-chain, skipping the origin", async () => {
    const m = await measureOutstanding(cfg, fakeFetcher({
      instances: {
        xrpl: base.xrpl,
        stellar: { supply: { tracked: "14000000" }, decimals: 6 },
        "xrpl-evm": { supply: "untracked", decimals: 18 },
        hedera: { supply: { tracked: "10000000" }, decimals: 6 },
        ethereum: base.other,
      },
      evmWei: "2000000000000000000", // 2 XRP
      hederaSupply: "8000000",
    }), );
    expect(Object.fromEntries(m.outstanding.map((s) => [s.chain, s.drops]))).toEqual({
      stellar: 14_000_000n, "xrpl-evm": 2_000_000n, hedera: 10_000_000n,
    });
    expect(m.unmeasured).toEqual([]);
    expect(m.alerts).toEqual([]);
  });

  it("reports an untracked destination without a measurer as unmeasured instead of ignoring it", async () => {
    const m = await measureOutstanding(cfg, fakeFetcher({
      instances: { xrpl: base.xrpl, newchain: { supply: "untracked", decimals: 6 } },
    }));
    expect(m.unmeasured).toEqual(["newchain"]);
    expect(m.outstanding).toEqual([]);
  });

  it("takes the larger figure and alerts when on-chain supply exceeds the Hub tracked supply", async () => {
    const m = await measureOutstanding(cfg, fakeFetcher({
      instances: { hedera: { supply: { tracked: "1000000" }, decimals: 6 } },
      hederaSupply: "1500000",
    }));
    expect(m.outstanding).toEqual([expect.objectContaining({ chain: "hedera", drops: 1_500_000n })]);
    expect(m.alerts).toHaveLength(1);
    expect(m.alerts[0]!.chain).toBe("hedera");
  });

  it("falls back to the next REST endpoint", async () => {
    const two = { ...cfg, axelar: { ...cfg.axelar, rest: ["https://axelar.test", "https://axelar.test"] } };
    const m = await measureOutstanding(two, fakeFetcher({
      instances: { stellar: { supply: { tracked: "7" }, decimals: 6 } }, failFirstHub: true,
    }));
    expect(m.outstanding[0]!.drops).toBe(7n);
  });

  it("rejects a malformed supply instead of treating it as zero", async () => {
    await expect(measureOutstanding(cfg, fakeFetcher({
      instances: { stellar: { supply: { tracked: "-5" }, decimals: 6 } },
    }))).rejects.toThrow(/unsigned integer/);
  });
});
