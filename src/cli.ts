// Usage:
//   npm run snapshot            gateway balance, signer list, reserve report -> data/latest.json
//   npm run deposits -- 90000000  classify gateway transactions from a ledger index onwards
//   npm run signers             compare current signer list with data/signers.json and print alerts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { XrplClient } from "./xrpl.js";
import { EvmClient } from "./evm.js";
import { computeReport } from "./reserves.js";
import { measureOutstanding, type DestinationMeasurement } from "./destinations.js";
import { classify } from "./deposits.js";
import { diffSignerLists, minSignersForQuorum } from "./signers.js";
import { dropsToXrp } from "./amounts.js";

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

async function snapshot() {
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
  writeFileSync(new URL("../data/latest.json", import.meta.url), json(out));
  console.log(json(out));
}

async function deposits(ledgerMin?: number) {
  const totals: Record<string, bigint> = {};
  for await (const entry of xrpl.accountTx(gateway, { ledgerMin })) {
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

const [cmd, arg] = process.argv.slice(2);
const run = { snapshot, deposits: () => deposits(arg ? Number(arg) : undefined), signers }[cmd ?? ""];
if (!run) {
  console.error("Commands: snapshot | deposits [ledgerMin] | signers");
  process.exit(1);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
