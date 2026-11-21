import { describe, it, expect, vi } from "vitest";
import { decodeTransferReceived, fetchMints, unionMints, TOPIC_TRANSFER_RECEIVED, MAX_LOG_RANGE } from "../src/evmlogs.js";
import { EvmClient, type EvmLog } from "../src/evm.js";

const pad = (hex: string) => hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
const num = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

/** ABI-encode (string, bytes, uint256, bytes32) like the ITS event data. */
function encodeData(sourceChain: string, sourceAddress: string, amount: bigint): string {
  const s = hex(sourceChain), a = hex(sourceAddress);
  const head = 4 * 32;
  const sEnc = num(s.length / 2) + pad(s);
  const aEnc = num(a.length / 2) + pad(a);
  return "0x" + num(head) + num(head + sEnc.length / 2) + num(amount) + num(0) + sEnc + aEnc;
}

const TOKEN = "0x" + "ab".repeat(32);
const log = (block: number, idx: number, to: string, amount: bigint, sender = "rhnu1DRT9AmPmz9C78WoAiEyXFdaGvxgfk"): EvmLog => ({
  address: "0xits", blockNumber: "0x" + block.toString(16), transactionHash: "0xtx" + block, logIndex: "0x" + idx.toString(16),
  topics: [TOPIC_TRANSFER_RECEIVED, "0x" + num(block + idx), TOKEN, "0x" + "00".repeat(12) + to.slice(2)],
  data: encodeData("xrpl", sender, amount),
});

describe("decodeTransferReceived", () => {
  it("decodes chain, XRPL sender, recipient, amount and ids", () => {
    const to = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    const m = decodeTransferReceived(log(8_708_342, 3, to, 50_000_000_000_000_000n));
    expect(m).toEqual({
      block: 8_708_342, tx: "0xtx8708342", logIndex: 3, commandId: "0x" + num(8_708_345), sourceChain: "xrpl",
      sourceAddress: "rhnu1DRT9AmPmz9C78WoAiEyXFdaGvxgfk", destinationAddress: to.toLowerCase(), amountWei: 50_000_000_000_000_000n,
    });
  });
  it("rejects other events and truncated data", () => {
    expect(() => decodeTransferReceived({ ...log(1, 0, "0x" + "11".repeat(20), 1n), topics: ["0xdead", "0x0", "0x0", "0x0"] })).toThrow(/not an InterchainTransferReceived/);
    const bad = log(1, 0, "0x" + "11".repeat(20), 1n);
    expect(() => decodeTransferReceived({ ...bad, data: bad.data.slice(0, 2 + 64 * 5) })).toThrow(/shorter/);
  });
});

/** Fake RPC: logs are filtered by the requested block range; block time = 2 s per block. */
function fakeEvm(logs: EvmLog[], opts: { failFirstLogsCall?: boolean } = {}) {
  const ranges: [number, number][] = [];
  let failed = false;
  const evm = new EvmClient("http://unused.test");
  vi.spyOn(evm, "getLogs").mockImplementation(async ({ fromBlock, toBlock }) => {
    if (opts.failFirstLogsCall && !failed) { failed = true; throw new Error("rpc hiccup"); }
    ranges.push([fromBlock, toBlock]);
    expect(toBlock - fromBlock).toBeLessThan(MAX_LOG_RANGE);
    return logs.filter((l) => Number(BigInt(l.blockNumber)) >= fromBlock && Number(BigInt(l.blockNumber)) <= toBlock);
  });
  vi.spyOn(evm, "blockTimestamp").mockImplementation(async (b) => 1_700_000_000 + b * 2);
  return { evm, ranges };
}

describe("fetchMints", () => {
  const to = "0x" + "11".repeat(20);
  const logs = [log(25_000, 1, to, 3n), log(5, 0, to, 1n), log(25_000, 0, to, 2n), log(9_999, 0, to, 4n)];

  it("covers the range in windows of at most 10,000 blocks and returns mints in chain order with timestamps", async () => {
    const { evm, ranges } = fakeEvm(logs);
    const mints = await fetchMints(evm, "0xits", TOKEN, 0, 29_999, { concurrency: 3 });
    expect(mints.map((m) => [m.block, m.logIndex])).toEqual([[5, 0], [9_999, 0], [25_000, 0], [25_000, 1]]);
    expect(mints[0]!.time).toBe(1_700_000_000 + 10);
    expect(ranges.sort((a, b) => a[0] - b[0])).toEqual([[0, 9_999], [10_000, 19_999], [20_000, 29_999]]);
  });

  it("does not skip or repeat the edge blocks and handles a final short window", async () => {
    const { evm, ranges } = fakeEvm([log(10_000, 0, to, 1n), log(10_001, 0, to, 2n)]);
    const mints = await fetchMints(evm, "0xits", TOKEN, 10_000, 10_001);
    expect(ranges).toEqual([[10_000, 10_001]]);
    expect(mints).toHaveLength(2);
  });

  it("retries a failed RPC call", async () => {
    vi.useFakeTimers();
    const { evm } = fakeEvm([log(7, 0, to, 1n)], { failFirstLogsCall: true });
    const p = fetchMints(evm, "0xits", TOKEN, 0, 100);
    await vi.runAllTimersAsync();
    expect(await p).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("EvmClient.blockAtOrAfter", () => {
  it("binary-searches the first block at or after a timestamp", async () => {
    const evm = new EvmClient("http://unused.test");
    const spy = vi.spyOn(evm, "blockTimestamp").mockImplementation(async (b) => 1000 + b * 2);
    expect(await evm.blockAtOrAfter(1000 + 2 * 777, 10_000)).toBe(777);
    expect(await evm.blockAtOrAfter(1000 + 2 * 777 - 1, 10_000)).toBe(777); // between two blocks: the later one
    expect(await evm.blockAtOrAfter(0, 10_000)).toBe(0);
    expect(await evm.blockAtOrAfter(10 ** 9, 10_000)).toBe(10_000); // clamped to latest
    expect(spy.mock.calls.length).toBeLessThan(80);
  });
});

describe("EvmClient.blockTimestamp", () => {
  it("retries a null block (a node without old blocks) before giving up", async () => {
    vi.useFakeTimers();
    const evm = new EvmClient("http://unused.test");
    const call = vi.spyOn(evm, "call").mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ timestamp: "0x64" });
    const p = evm.blockTimestamp(5);
    await vi.runAllTimersAsync();
    expect(await p).toBe(100);
    expect(call).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
  it("throws once the attempts are used up", async () => {
    vi.useFakeTimers();
    const evm = new EvmClient("http://unused.test");
    vi.spyOn(evm, "call").mockResolvedValue(null);
    const p = evm.blockTimestamp(5, 3).catch((e) => e);
    await vi.runAllTimersAsync();
    expect((await p).message).toMatch(/not found after 3 attempts/);
    vi.useRealTimers();
  });
});

describe("unionMints", () => {
  it("merges passes, drops repeats and keeps chain order", () => {
    const m = (block: number, logIndex: number) => ({ block, time: 0, tx: "0xtx" + block, logIndex, commandId: "0x", sourceChain: "xrpl", sourceAddress: "r", destinationAddress: "0x", amountWei: 1n });
    const u = unionMints([m(5, 0), m(9, 0)], [m(9, 0), m(7, 1), m(7, 0)]);
    expect(u.map((x) => [x.block, x.logIndex])).toEqual([[5, 0], [7, 0], [7, 1], [9, 0]]);
  });
});
