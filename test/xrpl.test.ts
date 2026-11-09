import { describe, it, expect, vi, afterEach } from "vitest";
import { XrplClient } from "../src/xrpl.js";

const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
const fast = { backoffMs: 1 };

afterEach(() => vi.unstubAllGlobals());

describe("XrplClient.request", () => {
  it("falls over to the next endpoint", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(ok({ status: "success", n: 1 }));
    vi.stubGlobal("fetch", f);
    expect((await new XrplClient(["https://a.test", "https://b.test"], fast).request("x", {})).n).toBe(1);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["https://a.test", "https://b.test"]);
  });

  it("starts at the requested endpoint so a retry can use another node", async () => {
    const f = vi.fn().mockResolvedValue(ok({ status: "success" }));
    vi.stubGlobal("fetch", f);
    await new XrplClient(["https://a.test", "https://b.test"], fast).request("x", {}, 1);
    expect(f.mock.calls[0]![0]).toBe("https://b.test");
  });

  it("retries transport failures over several rounds with backoff, then succeeds", async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(ok({ status: "success", n: 7 }));
    vi.stubGlobal("fetch", f);
    expect((await new XrplClient(["https://a.test"], fast).request("x", {})).n).toBe(7);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured rounds and throws the last transport error", async () => {
    const f = vi.fn().mockRejectedValue(new Error("dns down"));
    vi.stubGlobal("fetch", f);
    await expect(new XrplClient(["https://a.test"], { ...fast, rounds: 2 }).request("x", {})).rejects.toThrow("dns down");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not retry deterministic RPC errors beyond one pass over the endpoints", async () => {
    const f = vi.fn().mockImplementation(async () => ok({ status: "error", error: "actNotFound" }));
    vi.stubGlobal("fetch", f);
    await expect(new XrplClient(["https://a.test", "https://b.test"], fast).request("account_info", {})).rejects.toThrow("actNotFound");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("balanceAt treats a not-yet-created account as zero but surfaces other errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ok({ status: "error", error: "actNotFound" })));
    expect(await new XrplClient(["https://a.test"], fast).balanceAt("rX", 1)).toBe(0n);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ok({ status: "error", error: "lgrNotFound" })));
    await expect(new XrplClient(["https://a.test"], fast).balanceAt("rX", 1)).rejects.toThrow("lgrNotFound");
  });
});
