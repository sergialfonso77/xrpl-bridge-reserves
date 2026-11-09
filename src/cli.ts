// Usage:
//   npm run snapshot            gateway balance, signer list, reserve report -> data/latest.json
//   npm run deposits -- 107000000  classify gateway transactions from a ledger index onwards (balance-verified)
//   npm run site-data           snapshot + signer diff -> public/data/{latest,history}.json (scheduled job)
//   npm run notify [-- --test]  Telegram alerts from public/data/latest.json (env TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
//   npm run signers             compare current signer list with data/signers.json and print alerts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { XrplClient } from "./xrpl.js";
import { EvmClient } from "./evm.js";
import { computeReport } from "./reserves.js";
import { measureOutstanding, type DestinationMeasurement } from "./destinations.js";
import { classify } from "./deposits.js";
import { verifiedAccountTx } from "./history.js";
import { diffSignerLists, minSignersForQuorum } from "./signers.js";
import { dropsToXrp } from "./amounts.js";
import { appendHistory, historyPoint, toPublic, type Snapshot } from "./publish.js";
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

const [cmd, arg] = process.argv.slice(2);
const run = {
  snapshot,
  deposits: () => {
    if (!/^\d+$/.test(arg ?? "")) throw new Error("deposits needs a start ledger: npm run deposits -- <ledgerMin> (a full scan takes hours)");
    return deposits(Number(arg));
  },
  signers,
  publish,
  notify,
}[cmd ?? ""];
if (!run) {
  console.error("Commands: snapshot | deposits <ledgerMin> | signers | publish | notify [--test]");
  process.exit(1);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
