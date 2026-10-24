# xrpl-bridge-reserves — context for Claude Code

Owner: Sergi (Barcelona). Portfolio project in blockchain security. Code and docs in English;
talk to Sergi in Catalan.

## Goal
Open-source, public **proof of reserves + anomaly monitor** for XRP bridged from the XRPL to the
XRPL EVM through Axelar. Grows in phases:
1. Proof of reserves (XRP held by the gateway vs XRP outstanding on destination chains).
2. Event-level reconciliation (each XRPL deposit ↔ its mint on the destination; unmatched,
   delayed or orphan mints).
3. Alerts (signer list changes, undercollateralisation, anomalies) via Telegram.
4. Public static dashboard (GitHub Pages) fed by a scheduled job (GitHub Actions cron).
Academic reference: XChainWatcher (Augusto et al., 2024) — cross-chain rule-based detection.

## Verified facts (sources in README)
- Axelar XRPL multisig gateway — mainnet `rfmS3zqrQrka8wVyhXifEeyTwe8AMz2Yhw`,
  testnet `rNrjh1KGZk2jBR3wPfAQnoidtFFYQKbQn2`. Same account for ITS and GMP.
- Deposits are Payments to the gateway with hex memos: `type=interchain_transfer`,
  `destination_chain`, `destination_address` (hex, no 0x), `gas_fee_amount` (XRP: integer drops),
  optional `payload`. Net transferred = Amount − gas_fee_amount; gas_fee_amount must be < Amount
  or funds have no automated refund path.
- XRPL EVM mainnet: RPC https://rpc.xrplevm.org, chain id 1440000, explorer explorer.xrplevm.org.
  Native token XRP (18 decimals on EVM vs 6 on XRPL).

## OPEN QUESTIONS — resolve before trusting any report (phase 1 spike)
1. **The gateway serves several destination chains** (xrpl-evm, ethereum, hedera, …). Locked XRP
   backs XRP on ALL of them, so outstanding supply must be summed across every destination,
   or reconciled per destination from deposit/release history.
2. How is bridged XRP represented on the XRPL EVM? Native mint via ITS, an ERC-20 wrapper,
   a precompile? Does native supply include genesis / validator / fee allocations that are
   NOT bridge-backed? Find the token id / contract in Axelar ITS and docs.xrplevm.org.
3. What happens to `gas_fee_amount`: does it stay in the gateway balance or get paid out?
4. Transaction fees of multisig releases are paid by the gateway → small drift is expected.
`src/cli.ts#outstandingOnDestinations` returns `[]` until these are answered, so the report says
`status: "unverified"`. **Never hardcode or estimate this number.**

## Rules (security-critical, keep tests for each)
- Only `ledger_index: "validated"` data; ignore unvalidated or non-`tesSUCCESS` txs.
- Read `meta.delivered_amount`, never `Amount` (partial payments trap, tfPartialPayment 0x00020000).
- All amounts as BigInt drops. No floats except the display ratio.
- Handle API v1 (`tx`) and v2 (`tx_json`) shapes.
- Read-only tool: no keys, no signing, no custody.

## Layout
- `src/xrpl.ts`, `src/evm.ts` — dependency-free JSON-RPC clients
- `src/deposits.ts` — classify gateway txs (deposit/release/signer_list_set) + anomaly codes
- `src/signers.ts` — signer list diff, min signers to reach quorum
- `src/reserves.ts` — pure proof-of-reserves arithmetic
- `src/cli.ts` — `snapshot | deposits [ledgerMin] | signers`
- `test/` — vitest, fixtures built in `test/helpers.ts`

## Commands
npm test · npm run typecheck · npm run snapshot · npm run deposits -- <ledgerMin> · npm run signers
`NETWORK=testnet` switches config (testnet XRPL EVM values still TODO in config/networks.json).

## Status (2026-10-24)
- Scaffold, logic and 22 unit tests pass. **Live RPC calls not yet exercised** (the sandbox that
  wrote this could not reach XRPL nodes). First task: run `npm run snapshot` and
  `npm run signers` on the Mac, fix any response-shape issues, then start the phase 1 spike.
- No git repo yet: `git init` and first commit.

## Next steps
1. Live smoke test of the three commands; record real signer list (expect ~30 signers, quorum ~67%).
2. Phase 1 spike (open questions above) → implement `outstandingOnDestinations`.
3. GitHub Actions cron writing `data/latest.json` + static page in `public/`.
4. Reconciliation: match deposits to destination mints via Axelar GMP/ITS API (axelarscan).
5. Telegram alerts; write-up for the portfolio and an XAO DAO / XRPL Commons grant application.
