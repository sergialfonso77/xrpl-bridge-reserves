import { describe, it, expect } from "vitest";
import { classify } from "../src/deposits.js";
import { GATEWAY, payment, itsMemos, memo } from "./helpers.js";

describe("classify", () => {
  it("parses a well-formed ITS deposit and subtracts the gas fee", () => {
    const ev = classify(payment({ amount: "10000000", delivered: "10000000", memos: itsMemos() }), GATEWAY)!;
    expect(ev.kind).toBe("deposit");
    expect(ev.destinationChain).toBe("xrpl-evm");
    expect(ev.destinationAddress).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(ev.netDrops).toBe(9_900_000n);
    expect(ev.anomalies).toEqual([]);
  });

  it("uses delivered_amount, not Amount, on a partial payment", () => {
    const ev = classify(
      payment({ amount: "1000000000", delivered: "1000", flags: 0x00020000, memos: itsMemos("10") }),
      GATEWAY,
    )!;
    expect(ev.deliveredDrops).toBe(1000n);
    expect(ev.netDrops).toBe(990n);
    expect(ev.anomalies).toContain("partial_payment_flag");
    expect(ev.anomalies).toContain("amount_differs_from_delivered");
  });

  it("ignores unvalidated and failed transactions", () => {
    expect(classify(payment({ amount: "1", delivered: "1", validated: false }), GATEWAY)).toBeNull();
    expect(classify(payment({ amount: "1", delivered: "1", result: "tecPATH_DRY" }), GATEWAY)).toBeNull();
  });

  it("flags a deposit without Axelar memos", () => {
    const ev = classify(payment({ amount: "5000000", delivered: "5000000" }), GATEWAY)!;
    expect(ev.anomalies).toContain("missing_axelar_memos");
  });

  it("flags gas_fee_amount >= Amount (no refund path)", () => {
    const ev = classify(payment({ amount: "100000", delivered: "100000", memos: itsMemos("100000") }), GATEWAY)!;
    expect(ev.anomalies).toContain("gas_fee_not_less_than_amount");
    expect(ev.netDrops).toBeNull();
  });

  it("flags a non-integer gas fee for XRP", () => {
    const memos = [...itsMemos().slice(0, 3), memo("gas_fee_amount", "0.1")];
    const ev = classify(payment({ amount: "1000000", delivered: "1000000", memos }), GATEWAY)!;
    expect(ev.anomalies).toContain("gas_fee_not_integer_drops");
  });

  it("flags unavailable delivered_amount (pre-2014 style)", () => {
    const ev = classify(payment({ amount: "1000000", delivered: "unavailable", memos: itsMemos() }), GATEWAY)!;
    expect(ev.anomalies).toContain("delivered_amount_unavailable");
  });

  it("classifies outgoing payments from the gateway as releases", () => {
    const ev = classify(payment({ from: GATEWAY, to: "rRecipientXXXXXXXXXXXXXXXXXXXXXX", amount: "42", delivered: "42" }), GATEWAY)!;
    expect(ev.kind).toBe("release");
    expect(ev.deliveredDrops).toBe(42n);
  });

  it("marks IOU deposits as IOU without drops", () => {
    const iou = { currency: "524C555344000000000000000000000000000000", issuer: "rIssuer", value: "10" };
    const ev = classify(payment({ amount: iou as any, delivered: iou, memos: itsMemos() }), GATEWAY)!;
    expect(ev.asset).toBe("IOU");
    expect(ev.deliveredDrops).toBeNull();
  });

  it("records currency and issuer of a gateway-issued IOU without flagging it", () => {
    const iou = { currency: "SOL", issuer: GATEWAY, value: "6000000000000000e-32" };
    const ev = classify(payment({ amount: iou as any, delivered: iou }), GATEWAY)!;
    expect(ev.kind).toBe("deposit");
    expect(ev.currency).toBe("SOL");
    expect(ev.issuer).toBe(GATEWAY);
    expect(ev.anomalies).toEqual(["missing_axelar_memos"]);
  });

  it("flags an IOU deposit whose issuer is not the gateway", () => {
    const iou = { currency: "USD", issuer: "rOtherIssuerXXXXXXXXXXXXXXXXXXXX", value: "10" };
    const ev = classify(payment({ amount: iou as any, delivered: iou, memos: itsMemos() }), GATEWAY)!;
    expect(ev.issuer).toBe("rOtherIssuerXXXXXXXXXXXXXXXXXXXX");
    expect(ev.anomalies).toContain("iou_issuer_not_gateway");
  });

  it("flags an outgoing IOU release of a third-party issuer, but not of the gateway's own", () => {
    const own = { currency: "SHX", issuer: GATEWAY, value: "50000" };
    const foreign = { currency: "SHX", issuer: "rOtherIssuerXXXXXXXXXXXXXXXXXXXX", value: "1" };
    const to = "rRecipientXXXXXXXXXXXXXXXXXXXXXX";
    const ok = classify(payment({ from: GATEWAY, to, amount: own as any, delivered: own }), GATEWAY)!;
    const bad = classify(payment({ from: GATEWAY, to, amount: foreign as any, delivered: foreign }), GATEWAY)!;
    expect(ok.kind).toBe("release");
    expect(ok.anomalies).toEqual([]);
    expect(bad.anomalies).toEqual(["iou_issuer_not_gateway"]);
  });

  it("does not set currency/issuer on XRP events", () => {
    const ev = classify(payment({ amount: "1000000", delivered: "1000000", memos: itsMemos() }), GATEWAY)!;
    expect(ev.currency).toBeUndefined();
    expect(ev.issuer).toBeUndefined();
  });

  it("accepts API v1 entries ({tx, meta})", () => {
    const v2 = payment({ amount: "2000000", delivered: "2000000", memos: itsMemos() });
    const v1 = { tx: { ...v2.tx_json, hash: v2.hash, ledger_index: 1 }, meta: v2.meta, validated: true };
    expect(classify(v1, GATEWAY)!.netDrops).toBe(1_900_000n);
  });
});
