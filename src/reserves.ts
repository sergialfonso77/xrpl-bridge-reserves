// Proof-of-reserves arithmetic. Pure functions, no I/O.

export interface OutstandingSource {
  chain: string;          // e.g. "xrpl-evm"
  method: string;         // how it was measured, e.g. "erc20.totalSupply(0x...)"
  drops: bigint;
}

export interface ReserveInput {
  gatewayBalanceDrops: bigint;
  ownerCount: number;
  reserveBaseDrops: bigint;
  reserveIncrementDrops: bigint;
  outstanding: OutstandingSource[];
  /** Destination chains that hold the bridged token but could not be measured. */
  unmeasured?: string[];
}

export interface ReserveReport {
  gatewayBalanceDrops: bigint;
  ledgerReserveDrops: bigint;
  backingDrops: bigint;       // balance minus the part the ledger itself locks
  outstandingDrops: bigint;   // sum across all destination chains measured
  surplusDrops: bigint | null;
  collateralRatio: number | null;
  status: "backed" | "undercollateralised" | "unverified";
}

export function computeReport(i: ReserveInput): ReserveReport {
  const ledgerReserveDrops = i.reserveBaseDrops + BigInt(i.ownerCount) * i.reserveIncrementDrops;
  const backingDrops = i.gatewayBalanceDrops - ledgerReserveDrops;
  const outstandingDrops = i.outstanding.reduce((a, s) => a + s.drops, 0n);
  if (i.outstanding.length === 0 || (i.unmeasured?.length ?? 0) > 0) {
    return { gatewayBalanceDrops: i.gatewayBalanceDrops, ledgerReserveDrops, backingDrops, outstandingDrops, surplusDrops: null, collateralRatio: null, status: "unverified" };
  }
  const surplusDrops = backingDrops - outstandingDrops;
  const collateralRatio = outstandingDrops === 0n ? null : Number((backingDrops * 1_000_000n) / outstandingDrops) / 1_000_000;
  return {
    gatewayBalanceDrops: i.gatewayBalanceDrops, ledgerReserveDrops, backingDrops, outstandingDrops,
    surplusDrops, collateralRatio, status: surplusDrops >= 0n ? "backed" : "undercollateralised",
  };
}
