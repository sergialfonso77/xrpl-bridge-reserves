import { describe, it, expect, vi } from "vitest";
import { emptyAlertState, planNotifications, sendTelegram } from "../src/telegram.js";
import { toPublic, type Snapshot } from "../src/publish.js";
import type { SignerAlert } from "../src/signers.js";

const snap = (report: Partial<Snapshot["report"]> = {}, over: Partial<Snapshot> = {}): Snapshot => ({
  takenAt: "2026-11-09T12:00:00.000Z", network: "mainnet", gateway: "rGw", xrplLedger: 100,
  signerList: { quorum: 10, entries: [] }, minSignersForQuorum: 2,
  report: { gatewayBalanceDrops: "1", ledgerReserveDrops: "0", backingDrops: "1", outstandingDrops: "1", surplusDrops: "0", collateralRatio: 1.0047, status: "backed", ...report },
  outstanding: [], unmeasured: [], alerts: [], ...over,
});
const pub = (s = snap(), sa: SignerAlert[] = []) => toPublic(s, sa);
const URL = "https://example.test/";
const t0 = new Date("2026-11-09T12:00:00.000Z");
const hoursLater = (h: number) => new Date(t0.getTime() + h * 3_600_000);

describe("planNotifications", () => {
  it("is silent when healthy and nothing was open", () => {
    const r = planNotifications(pub(), emptyAlertState(), URL, t0);
    expect(r.messages).toEqual([]);
    expect(r.next).toEqual({ open: [], lastSent: null });
  });

  it("announces a new problem once, then stays quiet while it is unchanged", () => {
    const bad = pub(snap({ status: "undercollateralised" }));
    const first = planNotifications(bad, emptyAlertState(), URL, t0);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toContain("1 problem(s)");
    expect(first.messages[0]).toContain("undercollateralised");
    expect(first.messages[0]).toContain(URL);
    expect(planNotifications(bad, first.next, URL, hoursLater(1)).messages).toEqual([]);
  });

  it("repeats a still-open problem after 24 hours", () => {
    const bad = pub(snap({ status: "unverified" }));
    const first = planNotifications(bad, emptyAlertState(), URL, t0);
    expect(planNotifications(bad, first.next, URL, hoursLater(23)).messages).toEqual([]);
    const again = planNotifications(bad, first.next, URL, hoursLater(24));
    expect(again.messages[0]).toContain("still open");
    expect(again.next.lastSent).toBe(hoursLater(24).toISOString());
  });

  it("announces again when the set of problems changes", () => {
    const a = planNotifications(pub(snap({ status: "unverified" })), emptyAlertState(), URL, t0);
    const b = planNotifications(pub(snap({ status: "unverified" }, { unmeasured: ["newchain"] })), a.next, URL, hoursLater(1));
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]).not.toContain("still open");
  });

  it("sends a resolved message when problems clear", () => {
    const a = planNotifications(pub(snap({ status: "undercollateralised" })), emptyAlertState(), URL, t0);
    const b = planNotifications(pub(), a.next, URL, hoursLater(1));
    expect(b.messages).toHaveLength(1);
    expect(b.messages[0]).toContain("resolved");
    expect(b.next.open).toEqual([]);
    expect(planNotifications(pub(), b.next, URL, hoursLater(2)).messages).toEqual([]);
  });

  it("sends signer-list changes once and never treats them as open or resolved", () => {
    const alerts: SignerAlert[] = [{ severity: "critical", message: "Quorum changed 19 -> 10" }, { severity: "info", message: "ignore me" }];
    const a = planNotifications(pub(snap(), alerts), emptyAlertState(), URL, t0);
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]).toContain("signer list changed (1)");
    expect(a.messages[0]).toContain("Quorum changed 19 -> 10");
    expect(a.messages[0]).not.toContain("ignore me");
    expect(a.next.open).toEqual([]);
    expect(planNotifications(pub(), a.next, URL, hoursLater(1)).messages).toEqual([]); // no bogus "resolved"
  });

  it("ignores info-only signer alerts", () => {
    expect(planNotifications(pub(snap(), [{ severity: "info", message: "first observed" }]), emptyAlertState(), URL, t0).messages).toEqual([]);
  });
});

describe("sendTelegram", () => {
  const TOKEN = "123456:SECRET-TOKEN";
  it("posts plain text without parse_mode", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await sendTelegram(TOKEN, "42", "hello", f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ chat_id: "42", text: "hello", disable_web_page_preview: true });
  });

  it("throws on API errors without leaking the token", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }));
    const err = await sendTelegram(TOKEN, "42", "x", f as unknown as typeof fetch).catch((e) => e);
    expect(err.message).toContain("401");
    expect(err.message).toContain("Unauthorized");
    expect(err.message).not.toContain("SECRET");
  });

  it("hides the token when the network call itself fails", async () => {
    const f = vi.fn().mockRejectedValue(new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`));
    const err = await sendTelegram(TOKEN, "42", "x", f as unknown as typeof fetch).catch((e) => e);
    expect(err.message).not.toContain("SECRET");
  });
});
