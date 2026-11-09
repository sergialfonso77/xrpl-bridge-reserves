// Pure helpers for the scheduled publish job: public JSON, history time series, health verdict.
import { dropsToXrp } from "./amounts.js";
import type { SignerAlert } from "./signers.js";
import type { SignerList } from "./xrpl.js";

/** Snapshot as written by the CLI after JSON serialisation (bigints are decimal strings). */
export interface Snapshot {
  takenAt: string;
  network: string;
  gateway: string;
  xrplLedger: number;
  signerList: SignerList | null;
  minSignersForQuorum: number | null;
  report: {
    gatewayBalanceDrops: string;
    ledgerReserveDrops: string;
    backingDrops: string;
    outstandingDrops: string;
    surplusDrops: string | null;
    collateralRatio: number | null;
    status: "backed" | "undercollateralised" | "unverified";
  };
  outstanding: { chain: string; method: string; drops: string }[];
  unmeasured: string[];
  alerts: { chain: string; message: string }[];
}

export interface HistoryPoint {
  t: string;
  ledger: number;
  backing: string;
  outstanding: string;
  surplus: string | null;
  ratio: number | null;
  status: Snapshot["report"]["status"];
}

export const historyPoint = (s: Snapshot): HistoryPoint => ({
  t: s.takenAt,
  ledger: s.xrplLedger,
  backing: s.report.backingDrops,
  outstanding: s.report.outstandingDrops,
  surplus: s.report.surplusDrops,
  ratio: s.report.collateralRatio,
  status: s.report.status,
});

/**
 * Add a point and keep the file small: the last `fullDays` days stay at full resolution, older days
 * are reduced to their last point, and the series is capped at `maxPoints` (oldest dropped).
 */
export function appendHistory(history: HistoryPoint[], point: HistoryPoint, opts: { fullDays?: number; maxPoints?: number } = {}): HistoryPoint[] {
  const fullDays = opts.fullDays ?? 7;
  const maxPoints = opts.maxPoints ?? 2000;
  const byTime = new Map(history.map((p) => [p.t, p]));
  byTime.set(point.t, point);
  const all = [...byTime.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const cutoff = Date.parse(point.t) - fullDays * 86_400_000;
  const lastOfDay = new Map<string, HistoryPoint>();
  for (const p of all) if (Date.parse(p.t) < cutoff) lastOfDay.set(p.t.slice(0, 10), p);
  const recent = all.filter((p) => Date.parse(p.t) >= cutoff);
  return [...lastOfDay.values(), ...recent].slice(-maxPoints);
}

/** What the static page reads. No signer addresses: only the aggregate that matters for security. */
export function toPublic(s: Snapshot, signerAlerts: SignerAlert[]) {
  const outstanding = BigInt(s.report.outstandingDrops);
  return {
    schema: 1,
    takenAt: s.takenAt,
    network: s.network,
    gateway: s.gateway,
    xrplLedger: s.xrplLedger,
    report: s.report,
    human: {
      gatewayBalanceXrp: dropsToXrp(BigInt(s.report.gatewayBalanceDrops)),
      backingXrp: dropsToXrp(BigInt(s.report.backingDrops)),
      outstandingXrp: dropsToXrp(outstanding),
      surplusXrp: s.report.surplusDrops === null ? null : dropsToXrp(BigInt(s.report.surplusDrops)),
    },
    outstanding: s.outstanding,
    unmeasured: s.unmeasured,
    alerts: s.alerts,
    signers: s.signerList ? { count: s.signerList.entries.length, quorum: s.signerList.quorum, minForQuorum: s.minSignersForQuorum } : null,
    signerAlerts,
    problems: healthProblems(s, signerAlerts),
  };
}

/** Reasons the scheduled run should go red. Empty means healthy. `info` signer alerts are not problems. */
export function healthProblems(s: Snapshot, signerAlerts: SignerAlert[]): string[] {
  const problems: string[] = [];
  if (s.report.status !== "backed") problems.push(`reserve status is ${s.report.status}`);
  if (s.unmeasured.length) problems.push(`unmeasured destination chains: ${s.unmeasured.join(", ")}`);
  for (const a of s.alerts) problems.push(`${a.chain}: ${a.message}`);
  for (const a of signerAlerts) if (a.severity !== "info") problems.push(`signers [${a.severity}]: ${a.message}`);
  return problems;
}
