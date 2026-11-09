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
3. **gas_fee_amount — answered (full history scan, 2026-10-29, ledger 107,978,173).** Gas stays in the
   gateway balance. Balance 1,618,562.59 XRP = net minted (deposits − gas) − releases
   + gas fees 4,503.49 + other inflows 6,204.56 (add_reserves 2,600, unmemoed funding ~3,491, add_gas 90.7,
   call_contract 22.4) − fees paid by the gateway 2,414.94. The identity holds to 1 drop (every 50k-ledger
   window checked against `account_info`). Surplus implied by XRPL flows: 8,244.5 XRP; measured by `snapshot`:
   7,574.2 XRP. Gas fees are ~55% of the surplus; the rest is non-minting inflows minus release fees.
   Also: 203 deposits (≈38 XRP) have an unusable gas memo (gas ≥ amount, missing or non-integer): never minted,
   funds stuck in the gateway. 200 XRP of "releases" without memos are the account's initial funding going back
   to the setup account `rJJAm…`, not burns.
4. **Residual discrepancy (open).** Measured outstanding is ~470 XRP (0.03%) HIGHER than XRPL flows predict
   (net minted − bridge releases, after removing the 200 XRP setup transfer). Candidates, neither verified:
   (a) the Hub tracked supply for Stellar exceeds the real Stellar supply (Hedera shows the same direction,
   +2.7 XRP: Hub 10.88 vs mirror node 8.19), (b) native XRPL EVM supply includes non-bridge XRP.
   The direction is conservative (liabilities overstated, never understated).
Known limits: Stellar has no independent on-chain check; **account_tx over public clusters silently drops rows** (a 999 XRP payment was missing from a naive scan; ~160 rows of 5.8M): any history scan must be verified against account_info balances per ledger window and refetched when the gap is non-zero; measurements are not taken at the same
instant (small skew); native supply is rounded up to drops.

## Rules (security-critical, keep tests for each)
- Only `ledger_index: "validated"` data; ignore unvalidated or non-`tesSUCCESS` txs.
- Read `meta.delivered_amount`, never `Amount` (partial payments trap, tfPartialPayment 0x00020000).
- All amounts as BigInt drops. No floats except the display ratio.
- Handle API v1 (`tx`) and v2 (`tx_json`) shapes.
- Read-only tool: no keys, no signing, no custody.

## Layout
- `src/xrpl.ts`, `src/evm.ts` — dependency-free JSON-RPC clients
- `src/history.ts` — balance-verified `account_tx` (windows must match `account_info` balance deltas; refetch from another node, else throw `HistoryGapError`)
- `src/destinations.ts` — XRP outstanding per destination chain (ITS Hub enumeration)
- `src/deposits.ts` — classify gateway txs (deposit/release/signer_list_set) + anomaly codes
- `src/signers.ts` — signer list diff, min signers to reach quorum
- `src/reserves.ts` — pure proof-of-reserves arithmetic
- `src/publish.ts` — pure helpers for the scheduled job (public JSON, history downsampling, health verdict)
- `src/cli.ts` — `snapshot | deposits <ledgerMin> | signers | publish` (`npm run site-data`)
- `public/` — static dashboard (`index.html`, `style.css`, `app.js`; strict CSP, no inline code, `public/data/` is generated and gitignored)
- `.github/workflows/` — `ci.yml` (typecheck + tests) and `snapshot.yml` (hourly cron → Pages; state on the `data` branch)
- `test/` — vitest, fixtures built in `test/helpers.ts`

## Commands
npm test · npm run typecheck · npm run snapshot · npm run deposits -- <ledgerMin> (required; verified windows of 50k ledgers) · npm run signers
`NETWORK=testnet` switches config (testnet XRPL EVM values still TODO in config/networks.json; testnet has no destination config, so it stays `unverified`).

## Status (2026-10-24)
- Live smoke test done: `snapshot`, `signers`, `deposits` work on mainnet (signer list: 28 signers,
  quorum 19). `snapshot` now reports `backed`: backing 1,617,056.18 XRP vs outstanding 1,609,466.12 XRP.
- IOUs on the gateway are bridged tokens the gateway issues itself (SOL, SHX, mXRP…), not locked XRP;
  they are excluded from the XRP proof. `iou_issuer_not_gateway` flags third-party IOUs.
- 56 unit tests pass. Git repo initialised. Gateway history: 5.8M tx (mostly DEX/AMM noise from the gateway being an IOU issuer), 18.7k ITS XRP deposits, 10.3k releases.

## Next steps
1. History scans are now gap-checked (`src/history.ts`); never read `account_tx` any other way. Limit: a dropped
   tx that did not move the gateway's XRP balance (e.g. third-party IOU payments) is undetectable.
   Resolve the ~470 XRP residual (find the Stellar XRP token contract for an independent supply check).
2. Dashboard + cron are built and tested locally but NOT yet deployed: no git remote exists. To go live: create the
   GitHub repo, push, set Pages source to GitHub Actions, run the `snapshot` workflow once. Then add Telegram alerts
   (phase 3) on top of `problems` in `public/data/latest.json`.
3. Reconciliation: release memos carry `message_id` (`0x<hash>-<n>`) and `unsigned_tx_hash`; match
   deposits to destination mints via Axelar GMP/ITS API (axelarscan).
4. Telegram alerts; write-up for the portfolio and an XAO DAO / XRPL Commons grant application.
