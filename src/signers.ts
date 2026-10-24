// Detect changes to the multisig signer list of the gateway and measure its security margin.
import type { SignerList } from "./xrpl.js";

export interface SignerAlert {
  severity: "critical" | "warning" | "info";
  message: string;
}

/** Smallest number of signers whose weights reach the quorum (worst case for an attacker = best case). */
export function minSignersForQuorum(list: SignerList): number | null {
  const weights = list.entries.map((e) => e.weight).sort((a, b) => b - a);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i]!;
    if (acc >= list.quorum) return i + 1;
  }
  return null; // quorum unreachable
}

export function diffSignerLists(prev: SignerList | null, curr: SignerList | null): SignerAlert[] {
  const alerts: SignerAlert[] = [];
  if (!prev && !curr) return alerts;
  if (prev && !curr) return [{ severity: "critical", message: "Signer list removed from the gateway account" }];
  if (!prev && curr) return [{ severity: "info", message: `Signer list first observed (${curr.entries.length} signers, quorum ${curr.quorum})` }];

  const p = prev!, c = curr!;
  if (p.quorum !== c.quorum) {
    alerts.push({ severity: c.quorum < p.quorum ? "critical" : "warning", message: `Quorum changed ${p.quorum} -> ${c.quorum}` });
  }
  const before = new Map(p.entries.map((e) => [e.account, e.weight]));
  const after = new Map(c.entries.map((e) => [e.account, e.weight]));
  for (const [acct, w] of after) {
    if (!before.has(acct)) alerts.push({ severity: "warning", message: `Signer added ${acct} (weight ${w})` });
    else if (before.get(acct) !== w) alerts.push({ severity: "warning", message: `Signer ${acct} weight ${before.get(acct)} -> ${w}` });
  }
  for (const [acct] of before) {
    if (!after.has(acct)) alerts.push({ severity: "warning", message: `Signer removed ${acct}` });
  }
  const pm = minSignersForQuorum(p), cm = minSignersForQuorum(c);
  if (pm !== null && cm !== null && cm < pm) {
    alerts.push({ severity: "critical", message: `Fewer signers now needed to move funds: ${pm} -> ${cm}` });
  }
  if (cm === null) alerts.push({ severity: "critical", message: "Quorum is unreachable with current weights" });
  return alerts;
}
