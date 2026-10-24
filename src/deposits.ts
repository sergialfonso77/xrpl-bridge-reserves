// Classify validated XRPL transactions that touch the Axelar gateway account.
import { parseDrops } from "./amounts.js";
import { decodeMemos } from "./memos.js";

const TF_PARTIAL_PAYMENT = 0x00020000;

export type AnomalyCode =
  | "delivered_amount_unavailable"
  | "partial_payment_flag"
  | "amount_differs_from_delivered"
  | "missing_axelar_memos"
  | "gas_fee_not_less_than_amount"
  | "gas_fee_not_integer_drops"
  | "iou_issuer_not_gateway";

export interface GatewayEvent {
  hash: string;
  ledgerIndex: number;
  kind: "deposit" | "release" | "signer_list_set" | "other";
  asset: "XRP" | "IOU";
  currency?: string; // IOU only
  issuer?: string; // IOU only
  deliveredDrops: bigint | null; // XRP only
  gasFeeDrops: bigint | null;
  netDrops: bigint | null; // delivered - gas fee, what should appear on the destination
  destinationChain?: string;
  destinationAddress?: string;
  counterparty?: string;
  anomalies: AnomalyCode[];
}

/** Normalise API v1 ({tx, meta}) and API v2 ({tx_json, meta, hash}) entries. */
export function normaliseEntry(entry: any): { tx: any; meta: any; hash: string; ledgerIndex: number; validated: boolean } {
  const tx = entry.tx_json ?? entry.tx;
  return {
    tx,
    meta: entry.meta,
    hash: entry.hash ?? tx?.hash,
    ledgerIndex: entry.ledger_index ?? tx?.ledger_index,
    validated: entry.validated === true,
  };
}

export function classify(entry: any, gateway: string): GatewayEvent | null {
  const { tx, meta, hash, ledgerIndex, validated } = normaliseEntry(entry);
  // Rule 1: only validated ledgers, only successful transactions.
  if (!validated || !tx || meta?.TransactionResult !== "tesSUCCESS") return null;

  const base = { hash, ledgerIndex, gasFeeDrops: null, netDrops: null, anomalies: [] as AnomalyCode[] };

  if (tx.TransactionType === "SignerListSet" && tx.Account === gateway) {
    return { ...base, kind: "signer_list_set", asset: "XRP", deliveredDrops: null };
  }
  if (tx.TransactionType !== "Payment") {
    return { ...base, kind: "other", asset: "XRP", deliveredDrops: null };
  }

  // Rule 2: read delivered_amount, never Amount (partial payments trap).
  const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
  const isIou = typeof delivered === "object" && delivered !== null;
  const deliveredDrops = isIou ? null : parseDrops(delivered);
  const anomalies: AnomalyCode[] = [];
  const iou = isIou ? { currency: delivered.currency as string, issuer: delivered.issuer as string } : {};
  // Gateway-issued IOUs are bridged tokens, not locked XRP. An IOU from any other issuer has no automated path.
  if (isIou && delivered.issuer !== gateway) anomalies.push("iou_issuer_not_gateway");
  if (delivered === "unavailable" || (!isIou && deliveredDrops === null)) anomalies.push("delivered_amount_unavailable");

  const flags = Number(tx.Flags ?? 0);
  if ((flags & TF_PARTIAL_PAYMENT) !== 0) anomalies.push("partial_payment_flag");
  if (!isIou && deliveredDrops !== null && typeof tx.Amount === "string" && BigInt(tx.Amount) !== deliveredDrops) {
    anomalies.push("amount_differs_from_delivered");
  }

  if (tx.Destination === gateway) {
    const memos = decodeMemos(tx);
    let gasFeeDrops: bigint | null = null;
    let netDrops: bigint | null = null;
    if (!memos.destination_chain || !memos.destination_address) {
      anomalies.push("missing_axelar_memos");
    }
    if (!isIou && memos.gas_fee_amount !== undefined) {
      gasFeeDrops = parseDrops(memos.gas_fee_amount);
      if (gasFeeDrops === null) anomalies.push("gas_fee_not_integer_drops");
      else if (deliveredDrops !== null) {
        if (gasFeeDrops >= deliveredDrops) anomalies.push("gas_fee_not_less_than_amount");
        else netDrops = deliveredDrops - gasFeeDrops;
      }
    }
    return {
      hash, ledgerIndex, kind: "deposit", asset: isIou ? "IOU" : "XRP", ...iou,
      deliveredDrops, gasFeeDrops, netDrops,
      destinationChain: memos.destination_chain,
      destinationAddress: memos.destination_address,
      counterparty: tx.Account,
      anomalies,
    };
  }

  if (tx.Account === gateway) {
    return {
      ...base, kind: "release", asset: isIou ? "IOU" : "XRP", ...iou,
      deliveredDrops, counterparty: tx.Destination, anomalies,
    };
  }
  return { ...base, kind: "other", asset: isIou ? "IOU" : "XRP", ...iou, deliveredDrops, anomalies };
}
