// Axelar ITS/GMP memos on XRPL: MemoType and MemoData are hex-encoded ASCII.

export function hexToUtf8(hex: string): string {
  return Buffer.from(hex, "hex").toString("utf8");
}

export function decodeMemos(tx: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tx?.Memos ?? []) {
    const memo = m?.Memo;
    if (!memo?.MemoType) continue;
    const key = hexToUtf8(memo.MemoType);
    // destination_address and payload are themselves hex payloads: keep them as hex.
    const raw = memo.MemoData ?? "";
    out[key] = key === "destination_address" || key === "payload" ? raw.toLowerCase() : hexToUtf8(raw);
  }
  return out;
}

/**
 * destination_address on an EVM chain, as lowercase 40-hex without 0x. Senders encode it two ways: the 20 raw bytes
 * (40 hex chars of MemoData) or the ASCII text of the hex string, with or without "0x" (80 or 84 hex chars of
 * MemoData, which is what the Axelar relayer sends). Returns undefined when it is neither.
 */
export function evmAddressFromMemo(rawHex: string | undefined): string | undefined {
  if (!rawHex) return undefined;
  const h = rawHex.toLowerCase();
  if (/^[0-9a-f]{40}$/.test(h)) return h;
  if (!/^(?:[0-9a-f]{2})+$/.test(h)) return undefined;
  const text = hexToUtf8(h).toLowerCase().replace(/^0x/, "");
  return /^[0-9a-f]{40}$/.test(text) ? text : undefined;
}
