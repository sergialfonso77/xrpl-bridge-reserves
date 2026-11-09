// Telegram alerts for the scheduled job. Plain text only (no parse_mode), so on-chain derived strings can never
// become formatting. The bot token never appears in a thrown error or a log line.
import type { toPublic } from "./publish.js";

type Public = ReturnType<typeof toPublic>;

export interface AlertState {
  /** Persistent problems (status, unmeasured chains, supply alerts) that were open at the last notification. */
  open: string[];
  lastSent: string | null;
}

export const emptyAlertState = (): AlertState => ({ open: [], lastSent: null });

const REMINDER_MS = 24 * 60 * 60 * 1000;
const SIGNER_PREFIX = "signers [";

const summary = (p: Public) =>
  `Status: ${p.report.status}, ratio ${p.report.collateralRatio ?? "n/a"} (XRPL ledger ${p.xrplLedger}, ${p.takenAt})`;

/**
 * Decide which messages to send. Persistent problems are announced when they appear or change, repeated once
 * a day while open, and followed by a "resolved" message. Signer-list changes are one-shot events (the job moves
 * the baseline after reporting them), so they are sent once and never tracked as open.
 */
export function planNotifications(pub: Public, state: AlertState, pageUrl: string, now: Date): { messages: string[]; next: AlertState } {
  const messages: string[] = [];
  const events = pub.signerAlerts.filter((a) => a.severity !== "info");
  const persistent = pub.problems.filter((p) => !p.startsWith(SIGNER_PREFIX));
  const key = (l: string[]) => [...l].sort().join("\n");
  const changed = key(persistent) !== key(state.open);
  const dueReminder = state.lastSent === null || now.getTime() - Date.parse(state.lastSent) >= REMINDER_MS;
  let lastSent = state.lastSent;

  if (events.length) {
    messages.push(
      [`Gateway signer list changed (${events.length})`, ...events.map((a) => `- [${a.severity}] ${a.message}`), summary(pub), pageUrl].join("\n"),
    );
  }
  if (persistent.length && (changed || dueReminder)) {
    const head = changed ? `XRP bridge reserves: ${persistent.length} problem(s)` : `XRP bridge reserves: ${persistent.length} problem(s) still open`;
    messages.push([head, ...persistent.map((p) => `- ${p}`), summary(pub), pageUrl].join("\n"));
    lastSent = now.toISOString();
  } else if (!persistent.length && state.open.length) {
    messages.push(["XRP bridge reserves: resolved", ...state.open.map((p) => `- ${p}`), summary(pub), pageUrl].join("\n"));
    lastSent = now.toISOString();
  }
  return { messages, next: { open: persistent, lastSent } };
}

export async function sendTelegram(token: string, chatId: string, text: string, f: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await f(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }), // API limit is 4096
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Telegram request failed (network error)"); // the original error may carry the URL, i.e. the token
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok !== true) {
    throw new Error(`Telegram rejected the message: HTTP ${res.status} ${String(body?.description ?? "").slice(0, 200)}`.trim());
  }
}
