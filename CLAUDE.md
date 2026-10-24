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

## Phase 1 spike — findings (2026-10-24, verified live on mainnet)
XRP ITS token id `ba5a21ca88ef6bba2bfff5088994f90e1077e2a1cc3dcc38bd261f00fce2824f` (origin chain `xrpl`,
custom token, lock/unlock on XRPL, mint/burn on destinations). Source: Axelarscan `getITSAssets` + ITS Hub.
1. **Several destinations — answered.** Enumerate them from the ITS Hub (`its_chains`, then
   `token_instance{chain,token_id}`; contract in `config/networks.json`). Today: `xrpl-evm`, `hedera`
   and **`stellar`** (the docs and Axelarscan do not list Stellar; the Hub does: ~14,061 XRP).
   `src/destinations.ts` never uses a fixed list; an untracked chain without an on-chain measurer
   makes the report `unverified` (`unmeasured`).
2. **Representation — answered.** XRPL EVM: the *native* gas token (18 dec), token address
   `0xEeee…EEeE`, mintBurn manager `0xdb0a…aE8`. Its supply lives in the Cosmos layer, not `eth_*`:
   `GET cosmos-api.xrplevm.org/cosmos/bank/v1beta1/supply/by_denom?denom=axrp` (≈1,595,393 XRP).
   Hedera: HTS token `0.0.10447287` wXRP (6 dec), measured via mirror node. Stellar: Soroban token
   (address not found; measured only through the Hub tracked supply).
   The Hub reports `untracked` for xrpl-evm/xrpl and `tracked` for hedera/stellar. For tracked chains
   the Hub caps what can leave, so it is the liability; on-chain supply above it raises an alert.
   Native supply apparently has no non-bridge allocation (it is below the gateway backing).
3. **gas_fee_amount — not verified.** Hypothesis: it stays in the gateway balance and explains the
   current surplus (~7,590 XRP, ratio ~1.0047). Check by summing `gas_fee_drops` over the full history.
4. Release tx fees paid by the gateway → small drift is expected (still not measured).
Known limits: Stellar has no independent on-chain check; measurements are not taken at the same
instant (small skew); native supply is rounded up to drops.

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
`NETWORK=testnet` switches config (testnet XRPL EVM values still TODO in config/networks.json; testnet has no destination config, so it stays `unverified`).

## Status (2026-10-24)
- Live smoke test done: `snapshot`, `signers`, `deposits` work on mainnet (signer list: 28 signers,
  quorum 19). `snapshot` now reports `backed`: backing 1,617,056.18 XRP vs outstanding 1,609,466.12 XRP.
- IOUs on the gateway are bridged tokens the gateway issues itself (SOL, SHX, mXRP…), not locked XRP;
  they are excluded from the XRP proof. `iou_issuer_not_gateway` flags third-party IOUs.
- 33 unit tests pass. Git repo initialised.

## Next steps
1. Verify open item 3 (gas fees) by scanning the full gateway history; find the Stellar XRP token
   contract for an independent on-chain check.
2. GitHub Actions cron writing `data/latest.json` + static page in `public/`.
3. Reconciliation: release memos carry `message_id` (`0x<hash>-<n>`) and `unsigned_tx_hash`; match
   deposits to destination mints via Axelar GMP/ITS API (axelarscan).
4. Telegram alerts; write-up for the portfolio and an XAO DAO / XRPL Commons grant application.
