# Circle Gas Station — Sponsoring Buyer Gas

HostIT supports two ticket purchase paths:

1. **Fiat path** — buyer pays via Paystack/Monnify, backend treasury mints and delivers the NFT. Treasury signs every on-chain action; treasury holds funded ETH; buyers never touch the chain.
2. **Direct crypto path** — buyer pays in ETH, USDC, etc. by signing `mintTicket` (or `claimRefund`) from their own Circle wallet. **This path requires Gas Station** — without it, buyers would have to first acquire native ETH on Base just to send the user-op, defeating the whole point of a "tap to pay in stablecoins" UX.

This doc covers configuring Gas Station for path 2.

## How it works (in 30 seconds)

Every Circle SCA user-op routes through Circle's bundler. The bundler evaluates each user-op against your **Gas Station policies**: if a policy matches the wallet + contract + method combination, Circle's paymaster sponsors gas and your Gas Station account is debited. If no policy matches, the wallet falls back to paying its own gas (which only works if the wallet holds the chain's native token).

**No code changes are needed.** The same `createContractExecutionTransaction` call we already make from `CircleContractService` (or the buyer-side script in `scripts/blockchain/buy-ticket.ts`) automatically benefits once a policy is live. Sponsorship is a server-side decision; the wallet doesn't request it.

## Recommended policy for HostIT (Base Sepolia → Base)

Configure in the Circle Dashboard → **Gas Station** → **Policies** → **Create Policy**.

| Field | Value |
|---|---|
| **Name** | `hostit-buyer-direct-crypto` |
| **Network** | Base Sepolia (and a duplicate policy for Base mainnet at rollout) |
| **Wallet scope** | Wallet set → `hostit-users` (`CIRCLE_WALLET_SET_ID`) |
| **Allowed contracts** | Diamond address from `DIAMOND_CONTRACT_ADDRESS`<br>**+ each ERC20 fee token's contract** (see ERC20 callout below) |
| **Allowed methods (Diamond)** | `mintTicket(uint64,uint8,address)`<br>`claimRefund(uint64,uint8,uint256,address)` |
| **Allowed methods (each ERC20)** | `approve(address,uint256)` — scoped so spender must be the Diamond address |
| **Per-wallet daily cap** | $0.50 USD-equivalent at launch (raise as confidence grows) |
| **Policy total cap** | match the team's burn tolerance; on testnet, leave generous |

### The ERC20 approve callout

For ERC20 purchases (USDC, USDT, EURC, etc.) the buyer's flow is **two transactions**, not one:

1. `IERC20(token).approve(diamond, amount)` — gives Diamond permission to pull tokens
2. `Diamond.mintTicket(ticketId, feeType, buyer)` — Diamond does the `transferFrom` and mints

If Gas Station only sponsors method (2), the buyer is back to needing native ETH for method (1). So the policy must whitelist `approve(address,uint256)` on every ERC20 contract you support — at minimum **USDC** at launch (`0x036CbD53842c5426634e7929541eC2318f3dCF7e` on Base Sepolia, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base mainnet).

If you want to support more fee types (USDT, EURC, etc.) at the on-chain layer, add their contracts to the policy too. ETH purchases bypass approve entirely.

### Why scope so tightly

Three reasons:

1. **Cost control** — restricting to two Diamond methods + a single ERC20 selector means a compromised buyer wallet can't drain your Gas Station on arbitrary calls.
2. **Auditability** — Circle's Gas Station logs show "policy matched, sponsored 0.00001 ETH for `mintTicket(2,1,0x...)`". Tight policies make those logs reviewable.
3. **Fail-safe** — if a buyer somehow tries an unauthorized method (UI bug, attacker), it bounces with a clear reason rather than silently consuming sponsor funds.

## Funding the Gas Station

Gas Station is billed separately from your treasury wallet. On Base Sepolia testnet you typically get free credits; on mainnet you either:

- Fund a dedicated Gas Station account with native ETH (the dashboard exposes a deposit flow), or
- Bill via Circle's standard developer billing — check the dashboard for current options.

Top up enough to cover a few thousand mints at minimum so you're not chasing a faucet on launch day.

## Verifying it works

Empty the buyer wallet completely and re-run the buy script:

```bash
# Drain the buyer's ETH back to a known address (or just spend it elsewhere)
# Then:
pnpm blockchain:buy-ticket <ticketId> <buyerWalletId>
```

If Gas Station is live and matching:

- The mint succeeds despite the wallet having 0 ETH
- The wallet's ETH balance stays at 0 after the tx
- The Gas Station dashboard shows a debit ≈ the network fee for that user-op

If it fails with an "insufficient funds" or "AA21" / "AA22" / "AA31" error from the EntryPoint, the policy didn't match. Common causes:

- Policy isn't on the wallet's chain (Base Sepolia vs Base mainnet)
- Policy excludes the wallet set you're testing from
- The method signature mismatch (`mintTicket(uint64,uint8,address)` vs whatever the policy lists)
- For ERC20: missing `approve` policy on the token contract

## Production rollout checklist

- [ ] Create policy on Base Sepolia, verify with empty buyer wallet test
- [ ] Tighten daily caps based on testnet observed burn (~10–20× expected per-user spend)
- [ ] Duplicate the policy for Base mainnet with the **mainnet Diamond + mainnet USDC** addresses
- [ ] Fund Base mainnet Gas Station to cover at least 2 weeks of expected volume
- [ ] Add a Grafana / dashboard alert on Gas Station spend rate
- [ ] Document the policy ID in `.env.example` (info only — no env consumed; just for runbook reference)
- [ ] Drill: revoke a Gas Station policy and confirm buyer flows fail closed (no silent self-payment from buyer wallet)

## Why we still keep the treasury funded

Even with Gas Station live for buyers, the **treasury wallet still pays its own gas** for backend-signed operations: `createTicket` (event publish), `mintTicket` on the fiat path, `checkIn`, `withdrawTicketBalance`. Treasury writes are higher-volume than buyer writes for most events (one mint per ticket sold, regardless of payment path), so don't pull funded ETH from the treasury just because Gas Station is on for buyers.

If you want to push **everything** through Gas Station for unified billing, you can — add a second policy that matches the treasury wallet set (`hostit-treasury`) and whitelists `createTicket`, `setTicketFees`, `checkIn`, `withdrawTicketBalance`, `withdrawHostItBalance`. That's a finance-team decision, not a technical blocker.

## Related

- `docs/circle-treasury-rotation.md` — separate concern; covers rotating the platform treasury wallet
- Issue #67 — `CircleContractService` (treasury write path; benefits from Gas Station only if you opt in via the second policy above)
- Issue #69 — Circle Gateway (cross-chain USDC); buyer flows through Gateway also benefit from this policy
- hostit skill §3B — overall wallet provider architecture
