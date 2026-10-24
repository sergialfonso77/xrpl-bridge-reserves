// XRP amounts are always handled as integer drops (1 XRP = 1_000_000 drops) using BigInt.
// Never use floating point for balances.

export const DROPS_PER_XRP = 1_000_000n;

export function dropsToXrp(drops: bigint): string {
  const negative = drops < 0n;
  const abs = negative ? -drops : drops;
  const whole = abs / DROPS_PER_XRP;
  const frac = (abs % DROPS_PER_XRP).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** EVM native XRP uses 18 decimals (wei-like). Convert to drops (6 decimals), truncating. */
export function weiToDrops(wei: bigint): bigint {
  return wei / 1_000_000_000_000n;
}

export function parseDrops(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}
