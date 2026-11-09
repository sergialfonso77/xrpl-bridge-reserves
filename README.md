# xrpl-bridge-reserves

Open-source proof of reserves and anomaly monitor for XRP bridged between the **XRP Ledger** and
the **XRPL EVM sidechain** through **Axelar**.

> Status: early. The reserve report measures every destination chain of the bridged-XRP token
> (enumerated from the Axelar ITS Hub). A small residual (~0.03%) is still unexplained and Stellar
> has no independent on-chain check yet; see CLAUDE.md for the findings and limits.

## What it checks
- **Reserves** — XRP held by the Axelar multisig gateway on the XRPL (minus the ledger's own
  reserve) vs XRP outstanding on destination chains.
- **Deposits** — every validated payment into the gateway, decoded from Axelar memos, with
  anomaly codes: partial payments (`delivered_amount` ≠ `Amount`), missing memos, gas fee ≥ amount
  (unrefundable), non-integer XRP gas fee, unavailable delivered amount.
- **Signer set** — changes to the gateway's multisig `SignerList` (added/removed signers, weight
  changes, quorum changes) and how many signers are needed to move funds.

## Quick start
```bash
npm install
npm test
npm run snapshot          # writes data/latest.json
npm run signers           # alerts vs the last saved signer list (exit 2 on critical)
npm run deposits -- 108000000   # balance-verified history from that ledger
npm run site-data         # snapshot + signer diff -> public/data/{latest,history}.json
npm run notify -- --test  # Telegram test (needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)
```

## Public dashboard (GitHub Actions + Pages)
`.github/workflows/snapshot.yml` runs hourly: it takes a snapshot, publishes `public/` (a static,
dependency-free page with a strict Content-Security-Policy) to GitHub Pages and keeps its state
(signer-list baseline, history, `latest.json`) on a separate `data` branch, never on `main`.

One-time setup after pushing the repo: **Settings → Pages → Source: GitHub Actions**, then run the
`snapshot` workflow once (Actions tab → Run workflow). The page is deployed even when something is
wrong so it shows the problem; the run then fails so GitHub notifies you. A run is a failure when the
status is not `backed`, a destination chain is unmeasured, the Hub/chain supplies disagree, or the
signer list changes (warning or critical). The first signer-list observation is informational.

Notes: GitHub disables scheduled workflows after 60 days without repository activity; a changed
signer list alerts once (the baseline then moves to the new list). Third-party actions are pinned by
commit SHA.

## Telegram alerts
`npm run notify` (run by the workflow after each snapshot) sends plain-text messages to a Telegram chat:
- a **new or changed problem** (status not `backed`, unmeasured chain, supply disagreement), once;
- the same problem **still open** after 24 hours, as a reminder;
- **resolved**, when it clears;
- a **signer-list change** (warning or critical), once, because the baseline moves after it is reported;
- **job failure** (RPC down, deploy failed), from a separate job, since then nothing else would tell you.

Setup: create a bot with [@BotFather](https://t.me/BotFather), message it once, find your chat id, then store
both as repository secrets (`gh secret set TELEGRAM_BOT_TOKEN`, `gh secret set TELEGRAM_CHAT_ID`; `gh` asks for
the value, so it never lands in shell history). Without the secrets the step is skipped. Verify with
**Actions → snapshot → Run workflow → test_telegram**. The bot token is never logged or put in an error.

## Design principles
Validated ledgers only · `delivered_amount`, never `Amount` · BigInt drops, no floats ·
read-only, no keys · no number is reported that was not measured.

## Sources
- Axelar — XRPL Interchain Token Service: https://docs.axelar.dev/dev/send-tokens/xrpl/xrpl-its
- XRPL EVM — Connect to the XRPL EVM: https://docs.xrplevm.org/pages/users/getting-started/connect-to-the-xrpl-evm
- XRPL — Partial payments: https://xrpl.org/docs/concepts/payment-types/partial-payments
- Augusto et al. (2024), XChainWatcher: Monitoring and Identifying Attacks in Cross-Chain Bridges.

## License
MIT
