import { describe, it, expect } from "vitest";
import { computeReport } from "../src/reserves.js";
import { dropsToXrp, weiToDrops } from "../src/amounts.js";

const base = { gatewayBalanceDrops: 1_000_000_000n, ownerCount: 1, reserveBaseDrops: 1_000_000n, reserveIncrementDrops: 200_000n };

describe("reserve report", () => {
  it("is unverified when no destination supply was measured", () => {
    const r = computeReport({ ...base, outstanding: [] });
    expect(r.status).toBe("unverified");
    expect(r.ledgerReserveDrops).toBe(1_200_000n);
    expect(r.backingDrops).toBe(998_800_000n);
  });

  it("stays unverified when a destination holding the token was not measured", () => {
    const r = computeReport({ ...base, unmeasured: ["newchain"], outstanding: [{ chain: "xrpl-evm", method: "test", drops: 1n }] });
    expect(r.status).toBe("unverified");
    expect(r.surplusDrops).toBeNull();
  });

  it("is backed when backing covers outstanding supply", () => {
    const r = computeReport({ ...base, outstanding: [{ chain: "xrpl-evm", method: "test", drops: 900_000_000n }] });
    expect(r.status).toBe("backed");
    expect(r.surplusDrops).toBe(98_800_000n);
  });

  it("is undercollateralised when outstanding exceeds backing", () => {
    const r = computeReport({ ...base, outstanding: [
      { chain: "xrpl-evm", method: "test", drops: 600_000_000n },
      { chain: "ethereum", method: "test", drops: 600_000_000n },
    ] });
    expect(r.status).toBe("undercollateralised");
    expect(r.collateralRatio).toBeCloseTo(0.832333, 5);
  });
});

describe("amounts", () => {
  it("formats drops as XRP without floats", () => {
    expect(dropsToXrp(1_500_000n)).toBe("1.5");
    expect(dropsToXrp(1n)).toBe("0.000001");
    expect(dropsToXrp(-2_000_000n)).toBe("-2");
  });
  it("converts 18-decimal wei to drops", () => {
    expect(weiToDrops(1_000_000_000_000_000_000n)).toBe(1_000_000n);
  });
});
