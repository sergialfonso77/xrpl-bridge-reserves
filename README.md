# xrpl-bridge-reserves

Open-source proof of reserves and anomaly monitor for XRP bridged between the **XRP Ledger** and
the **XRPL EVM sidechain** through **Axelar**.

> Status: early. Unit-tested core logic; the reserve report stays `unverified` until the
> representation of bridged XRP on every destination chain is established (see CLAUDE.md).

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
npm run deposits -- 95000000
```

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
