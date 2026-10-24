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
