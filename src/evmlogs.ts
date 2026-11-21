// Mints of the bridged XRP on XRPL EVM, read from the Axelar ITS `InterchainTransferReceived` event.
// Dependency-free: the few ABI shapes we need are decoded by hand.
import type { EvmClient } from "./evm.js";

/** keccak256("InterchainTransferReceived(bytes32,bytes32,string,bytes,address,uint256,bytes32)") */
export const TOPIC_TRANSFER_RECEIVED = "0xbdb65cfd017af0876344138f62bc895163b5fd120cbe6e666ed306afd658de4b";
export const MAX_LOG_RANGE = 10_000;

export interface Mint {
  block: number;
  time: number; // unix seconds of the block
  tx: string;
  logIndex: number;
  commandId: string;
  sourceChain: string;
  sourceAddress: string; // for XRPL: the sender's r-address
  destinationAddress: string; // lowercase 0x…
  amountWei: bigint;
}

const word = (hex: string, i: number) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);

/** Dynamic `bytes`/`string` whose offset is stored in head word `offsetWord`; returns its raw hex. */
function dynamicBytes(hex: string, offsetWord: number): string {
  const off = Number(BigInt("0x" + word(hex, offsetWord))) / 32;
  const len = Number(BigInt("0x" + word(hex, off)));
  const start = 2 + (off + 1) * 64;
  if (start + len * 2 > hex.length) throw new Error("event data shorter than its declared length");
  return hex.slice(start, start + len * 2);
}

const utf8 = (hex: string) => Buffer.from(hex, "hex").toString("utf8");

/**
 * data = (string sourceChain, bytes sourceAddress, uint256 amount, bytes32 dataHash);
 * topics = [sig, commandId, tokenId, destinationAddress].
 */
export function decodeTransferReceived(log: { topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string }): Omit<Mint, "time"> {
  if (log.topics.length !== 4 || log.topics[0]!.toLowerCase() !== TOPIC_TRANSFER_RECEIVED) throw new Error("not an InterchainTransferReceived log");
  return {
    block: Number(BigInt(log.blockNumber)),
    tx: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    commandId: log.topics[1]!.toLowerCase(),
    sourceChain: utf8(dynamicBytes(log.data, 0)),
    sourceAddress: utf8(dynamicBytes(log.data, 1)),
    destinationAddress: "0x" + log.topics[3]!.slice(26).toLowerCase(),
    amountWei: BigInt("0x" + word(log.data, 2)),
  };
}

/**
 * Union of mints read in several passes. A load-balanced RPC can answer a range from a node that lacks the data and
 * return no logs without any error, so a log missing from one pass may be present in another.
 */
export function unionMints(...passes: Mint[][]): Mint[] {
  const byId = new Map<string, Mint>();
  for (const m of passes.flat()) byId.set(`${m.tx}:${m.logIndex}`, m);
  return [...byId.values()].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

export interface FetchMintsOptions {
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/** All XRP mints of `tokenId` through `its` in [fromBlock, toBlock], with block timestamps, in chain order. */
export async function fetchMints(evm: EvmClient, its: string, tokenId: string, fromBlock: number, toBlock: number, opts: FetchMintsOptions = {}): Promise<Mint[]> {
  const windows: [number, number][] = [];
  for (let from = fromBlock; from <= toBlock; from += MAX_LOG_RANGE) windows.push([from, Math.min(from + MAX_LOG_RANGE - 1, toBlock)]);

  const perWindow: Omit<Mint, "time">[][] = new Array(windows.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < windows.length) {
      const i = next++;
      const [from, to] = windows[i]!;
      const logs = await withRetries(() => evm.getLogs({ address: its, topics: [TOPIC_TRANSFER_RECEIVED, null, tokenId], fromBlock: from, toBlock: to }));
      perWindow[i] = logs.map(decodeTransferReceived);
      opts.onProgress?.(++done, windows.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));

  const flat = perWindow.flat().sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const blocks = [...new Set(flat.map((m) => m.block))];
  const timeOf = new Map<number, number>();
  let nextBlock = 0;
  const timeWorker = async () => {
    while (nextBlock < blocks.length) {
      const b = blocks[nextBlock++]!;
      timeOf.set(b, await withRetries(() => evm.blockTimestamp(b)));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, timeWorker));
  return flat.map((m) => ({ ...m, time: timeOf.get(m.block)! }));
}

async function withRetries<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** (i - 1))));
    }
  }
}
