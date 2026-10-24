export const GATEWAY = "rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw";
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex").toUpperCase();

export function memo(type: string, data: string, rawHex = false) {
  return { Memo: { MemoType: hex(type), MemoData: rawHex ? data : hex(data) } };
}

/** Build an account_tx entry in API v2 shape. */
export function payment(opts: {
  from?: string; to?: string; amount: string; delivered: unknown; flags?: number;
  memos?: unknown[]; result?: string; validated?: boolean;
}) {
  return {
    hash: "ABC" + Math.random().toString(16).slice(2),
    ledger_index: 95_000_000,
    validated: opts.validated ?? true,
    tx_json: {
      TransactionType: "Payment",
      Account: opts.from ?? "rUserXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      Destination: opts.to ?? GATEWAY,
      Amount: opts.amount,
      Flags: opts.flags ?? 0,
      Memos: opts.memos ?? [],
    },
    meta: { TransactionResult: opts.result ?? "tesSUCCESS", delivered_amount: opts.delivered },
  };
}

export const itsMemos = (gasFee = "100000") => [
  memo("type", "interchain_transfer"),
  memo("destination_address", "1234567890ABCDEF1234567890ABCDEF12345678", true),
  memo("destination_chain", "xrpl-evm"),
  memo("gas_fee_amount", gasFee),
];
