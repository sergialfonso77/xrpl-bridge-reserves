// Usage:
//   npm run snapshot            gateway balance, signer list, reserve report -> data/latest.json
//   npm run deposits -- 107000000  classify gateway transactions from a ledger index onwards (balance-verified)
//   npm run site-data           snapshot + signer diff -> public/data/{latest,history}.json (scheduled job)
//   npm run notify [-- --test]  Telegram alerts from public/data/latest.json (env TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
//   npm run reconcile -- <ledger> [max] pair XRPL deposits to xrpl-evm with their EVM mints -> data/reconcile.json
//   npm run signers             compare current signer list with data/signers.json and print alerts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { XrplClient } from "./xrpl.js";
import { EvmClient } from "./evm.js";
import { computeReport } from "./reserves.js";
import { measureOutstanding, itsEdgeContract, type DestinationMeasurement } from "./destinations.js";
import { classify } from "./deposits.js";
import { verifiedAccountTx } from "./history.js";
import { diffSignerLists, minSignersForQuorum } from "./signers.js";
import { dropsToXrp } from "./amounts.js";
import { appendHistory, historyPoint, toPublic, type Snapshot } from "./publish.js";
import { fetchMints, unionMints } from "./evmlogs.js";
import { reconcile, summarise, WEI_PER_DROP, type Deposit } from "./reconcile.js";
import { emptyAlertState, planNotifications, sendTelegram } from "./telegram.js";

const network = process.env.NETWORK ?? "mainnet";
const config = JSON.parse(readFileSync(new URL("../config/networks.json", import.meta.url), "utf8"))[network];
const gateway: string = config.xrpl.axelarGateway;
const xrpl = new XrplClient(config.xrpl.rpc);

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function outstandingOnDestinations(): Promise<DestinationMeasurement> {
  // Testnet has no destination config yet: stay "unverified" rather than guess.
  if (!config.axelar) return { outstanding: [], unmeasured: [], alerts: [] };
  return measureOutstanding({ axelar: config.axelar, xrplEvm: config.xrplEvm, hedera: config.hedera });
}

async function takeSnapshot() {
  const [acct, res] = await Promise.all([xrpl.accountSnapshot(gateway), xrpl.reserves()]);
  let evm: unknown = null;
  try {
    const client = new EvmClient(config.xrplEvm.rpc);
    const [chainId, block] = await Promise.all([client.chainId(), client.blockNumber()]);
    if (chainId !== config.xrplEvm.chainId) throw new Error(`Unexpected chain id ${chainId}`);
    evm = { chainId, block };
  } catch (e) {
    evm = { error: String(e) };
  }
  const { outstanding, unmeasured, alerts } = await outstandingOnDestinations();
  const report = computeReport({
    gatewayBalanceDrops: acct.balanceDrops,
    ownerCount: acct.ownerCount,
    reserveBaseDrops: res.baseDrops,
    reserveIncrementDrops: res.incrementDrops,
    outstanding,
    unmeasured,
  });
  const out = {
    takenAt: new Date().toISOString(),
    network,
    gateway,
    xrplLedger: acct.ledgerIndex,
    evm,
    signerList: acct.signerList,
    minSignersForQuorum: acct.signerList ? minSignersForQuorum(acct.signerList) : null,
    report,
    human: { gatewayBalanceXrp: dropsToXrp(report.gatewayBalanceDrops), backingXrp: dropsToXrp(report.backingDrops) },
    outstanding,
    unmeasured,
    alerts,
  };
  return out;
}

async function snapshot() {
  const out = await takeSnapshot();
  writeFileSync(new URL("../data/latest.json", import.meta.url), json(out));
  console.log(json(out));
}

/** Scheduled job: snapshot + signer diff -> public/data/{latest,history}.json. Exit code stays 0; the workflow reads `problems`. */
async function publish() {
  const out = JSON.parse(json(await takeSnapshot())) as Snapshot;
  const signersPath = new URL("../data/signers.json", import.meta.url);
  const historyPath = new URL("../data/history.json", import.meta.url);
  const publicDir = new URL("../public/data/", import.meta.url);
  const prev = existsSync(signersPath) ? JSON.parse(readFileSync(signersPath, "utf8")) : null;
  const signerAlerts = diffSignerLists(prev, out.signerList);
  const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];
  const nextHistory = appendHistory(history, historyPoint(out));
  const pub = toPublic(out, signerAlerts);
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(new URL("latest.json", publicDir), json(pub));
  writeFileSync(new URL("history.json", publicDir), JSON.stringify(nextHistory));
  // State for the next run (kept on the `data` branch by the workflow).
  writeFileSync(historyPath, JSON.stringify(nextHistory));
  if (out.signerList) writeFileSync(signersPath, json(out.signerList));
  console.log(`status=${pub.report.status} ratio=${pub.report.collateralRatio} problems=${pub.problems.length}`);
  for (const p of pub.problems) console.log(`PROBLEM: ${p}`);
}

async function deposits(ledgerMin: number) {
  const totals: Record<string, bigint> = {};
  const ledgerMax = await xrpl.validatedLedger();
  const history = verifiedAccountTx(xrpl, gateway, {
    ledgerMin,
    ledgerMax,
    onWindow: (w) => console.error(`verified ${w.ledgerMin}..${w.ledgerMax}: ${w.entries} tx${w.attempts > 1 ? ` (${w.attempts} attempts)` : ""}`),
  });
  for await (const entry of history) {
    const ev = classify(entry, gateway);
    if (!ev || ev.kind === "other") continue;
    if (ev.kind === "deposit" && ev.netDrops !== null) {
      const k = ev.destinationChain ?? "unknown";
      totals[k] = (totals[k] ?? 0n) + ev.netDrops;
    }
    if (ev.anomalies.length || ev.kind !== "deposit") console.log(json(ev));
  }
  console.log("Net XRP deposited per destination chain:");
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k}: ${dropsToXrp(v)} XRP`);
}

/**
 * Pair every XRPL deposit to xrpl-evm since `ledgerMin` with its mint on XRPL EVM (ITS `InterchainTransferReceived`).
 * Unmatched deposits younger than PENDING_S are "in flight"; mints in the first EDGE_S seconds with no deposit are
 * "edge" mints (their deposit happened before the window) and mints after its last ledger are "trailing"; none is a finding.
 */
async function reconcileCmd(ledgerMin: number, ledgerMaxArg?: number) {
  const PENDING_S = Number(process.env.PENDING_SECONDS ?? 3600), EDGE_S = Number(process.env.EDGE_SECONDS ?? 21600);
  const chain: string = config.xrplEvm.axelarChainName;
  const evm = new EvmClient(config.xrplEvm.rpc);
  const [validated, startTime, its] = await Promise.all([xrpl.validatedLedger(), xrpl.ledgerCloseTime(ledgerMin), itsEdgeContract(config.axelar, chain)]);
  const ledgerMax = Math.min(ledgerMaxArg ?? validated, validated);
  // Historical window: look 1 h past its end for the mints of the last deposits, and age things as of then.
  const windowEnd = await xrpl.ledgerCloseTime(ledgerMax);
  const endTime = ledgerMaxArg === undefined ? undefined : windowEnd + 3600;

  const deposits: Deposit[] = [];
  const skipped: { hash: string; reason: string }[] = [];
  for await (const entry of verifiedAccountTx(xrpl, gateway, {
    ledgerMin, ledgerMax,
    onWindow: (w) => console.error(`xrpl ${w.ledgerMin}..${w.ledgerMax} verified: ${w.entries} tx${w.attempts > 1 ? ` (${w.attempts} attempts)` : ""}`),
  })) {
    const ev = classify(entry, gateway);
    if (!ev || ev.kind !== "deposit" || ev.asset !== "XRP" || ev.destinationChain !== chain) continue;
    if (ev.netDrops === null || !ev.counterparty || ev.closeTime === undefined) { skipped.push({ hash: ev.hash, reason: ev.anomalies.join(",") || "no net amount" }); continue; }
    if (!/^[0-9a-f]{40}$/.test(ev.destinationAddress ?? "")) { skipped.push({ hash: ev.hash, reason: "destination_address is not a 20-byte hex address" }); continue; }
    deposits.push({ hash: ev.hash, ledger: ev.ledgerIndex, time: ev.closeTime, sender: ev.counterparty, destinationAddress: "0x" + ev.destinationAddress, netDrops: ev.netDrops });
  }

  const latest = await evm.blockNumber();
  const head = endTime === undefined ? latest : Math.min(latest, await evm.blockAtOrAfter(endTime, latest));
  const fromBlock = await evm.blockAtOrAfter(startTime, latest);
  const tokenId = "0x" + config.axelar.xrpTokenId;
  const progress = (d: number, t: number) => d % 20 === 0 && console.error(`evm windows ${d}/${t}`);
  let allMints = await fetchMints(evm, its, tokenId, fromBlock, head, { onProgress: progress });
  const fromXrpl = (l: typeof allMints) => l.filter((m) => m.sourceChain === config.axelar.originChain);
  let mints = fromXrpl(allMints);
  let r = reconcile(deposits, mints);
  let evmPasses = 1;
  // An unmatched deposit may just be a log the RPC failed to return: read again and take the union before accusing.
  for (; r.unmatchedDeposits.length > 0 && evmPasses < 3; evmPasses++) {
    console.error(`${r.unmatchedDeposits.length} unmatched deposit(s): re-reading EVM logs (pass ${evmPasses + 1})`);
    allMints = unionMints(allMints, await fetchMints(evm, its, tokenId, fromBlock, head, { onProgress: progress }));
    mints = fromXrpl(allMints);
    r = reconcile(deposits, mints);
  }
  const now = endTime ?? Math.floor(Date.now() / 1000);
  const inFlight = r.unmatchedDeposits.filter((d) => now - d.time < PENDING_S);
  const stuck = r.unmatchedDeposits.filter((d) => now - d.time >= PENDING_S);
  // A mint after the window's last ledger may belong to a deposit just after it; one in the first EDGE_S seconds, to a deposit just before it.
  const trailing = r.orphanMints.filter((m) => m.time > windowEnd - 120);
  const edge = r.orphanMints.filter((m) => m.time <= windowEnd - 120 && m.time - startTime < EDGE_S);
  const orphans = r.orphanMints.filter((m) => m.time <= windowEnd - 120 && m.time - startTime >= EDGE_S);
  const dep = (d: Deposit) => ({ hash: d.hash, ledger: d.ledger, time: new Date(d.time * 1000).toISOString(), ageHours: +((now - d.time) / 3600).toFixed(1), sender: d.sender, to: d.destinationAddress, netXrp: dropsToXrp(d.netDrops) });
  const mnt = (m: (typeof mints)[number]) => ({ tx: m.tx, block: m.block, time: new Date(m.time * 1000).toISOString(), sender: m.sourceAddress, to: m.destinationAddress, xrp: dropsToXrp(m.amountWei / WEI_PER_DROP) });
  const s = summarise({ ...r, unmatchedDeposits: stuck, orphanMints: orphans }, deposits.length, mints.length);
  const out = {
    network, ledgerRange: [ledgerMin, ledgerMax], evmBlockRange: [fromBlock, head], evmPasses, its, takenAt: new Date().toISOString(),
    summary: { ...s, matched: r.matched.length, unmatchedXrp: dropsToXrp(s.unmatchedDrops), orphanXrp: dropsToXrp(s.orphanDrops), inFlight: inFlight.length, edgeMints: edge.length, trailingMints: trailing.length,
      skippedDeposits: skipped.length, mintsFromOtherChains: allMints.length - mints.length,
      delaySeconds: r.matched.length ? summarise(r, deposits.length, mints.length).delaySeconds : null },
    stuckDeposits: stuck.map(dep), inFlightDeposits: inFlight.map(dep), orphanMints: orphans.map(mnt), skipped,
  };
  writeFileSync(new URL("../data/reconcile.json", import.meta.url), json(out));
  console.log(json(out));
}

async function signers() {
  const statePath = new URL("../data/signers.json", import.meta.url);
  const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  const { signerList } = await xrpl.accountSnapshot(gateway);
  const alerts = diffSignerLists(prev, signerList);
  for (const a of alerts) console.log(`[${a.severity.toUpperCase()}] ${a.message}`);
  if (alerts.length === 0) console.log("No signer list changes.");
  writeFileSync(statePath, json(signerList));
  if (alerts.some((a) => a.severity === "critical")) process.exitCode = 2;
}

/** Telegram alerts from public/data/latest.json. Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; skips quietly without them. `--test` sends a hello. */
async function notify() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set): skipping.");
    return;
  }
  const pageUrl = process.env.PAGE_URL ?? "";
  if (arg === "--test") {
    await sendTelegram(token, chatId, `XRP bridge reserves: Telegram alerts are configured.\n${pageUrl}`);
    console.log("Telegram test message sent.");
    return;
  }
  const pub = JSON.parse(readFileSync(new URL("../public/data/latest.json", import.meta.url), "utf8")) as ReturnType<typeof toPublic>;
  const statePath = new URL("../data/alert-state.json", import.meta.url);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : emptyAlertState();
  const { messages, next } = planNotifications(pub, state, pageUrl, new Date());
  for (const m of messages) await sendTelegram(token, chatId, m);
  writeFileSync(statePath, json(next)); // only after every message went out, so a failed send is retried next run
  console.log(`Telegram: ${messages.length} message(s) sent.`);
}

const [cmd, arg, arg2] = process.argv.slice(2);
const run = {
  snapshot,
  deposits: () => {
    if (!/^\d+$/.test(arg ?? "")) throw new Error("deposits needs a start ledger: npm run deposits -- <ledgerMin> (a full scan takes hours)");
    return deposits(Number(arg));
  },
  signers,
  publish,
  notify,
  reconcile: () => {
    if (!/^\d+$/.test(arg ?? "")) throw new Error("reconcile needs a start ledger: npm run reconcile -- <ledgerMin>");
    return reconcileCmd(Number(arg), /^\d+$/.test(arg2 ?? "") ? Number(arg2) : undefined);
  },
}[cmd ?? ""];
if (!run) {
  console.error("Commands: snapshot | deposits <ledgerMin> | signers | publish | notify [--test] | reconcile <ledgerMin> [ledgerMax]");
  process.exit(1);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
