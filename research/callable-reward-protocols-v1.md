# Callable Reward Protocol Scan — v2

**Status: 20 distinct protocols indexed, 0 meet all strict qualification requirements.** This is a screening catalog, **not** 20 proven profitable or recently rewarded protocols.

Scope: permissionless maintenance/harvest/fee-processing bounties; borrower liquidations and DEX arbitrage excluded. Seven-day evidence window: **2026-10-25 through 2026-11-01 UTC**. Priority: Ethereum, Base, then Arbitrum. No modelled future yield used as recent payout evidence.

## On-chain transaction finding

**Beefy Ethereum strategy `0xDEF1be4D80a990847f8C7A1e15e824fF2749C0DE`:** [Oct 31 harvest](https://etherscan.io/tx/0x874fe63b9c29cacecf940c0adfbd123057c1949d839737cbb2ce5a2adc299ea0) called by EOA `0xd5e87f1f003f222188cc8c5aeefc8b285738b7e7` through router `0xbc6dbe2c5f172bbb736aa58cfa9bfcb20c85ffe2`. Strategy paid router `0.000034028401462443 WETH`. Sender gas paid `0.000049463206763321 ETH`. The receipt contains additional CRV and crvUSD receipts to router from other operations; no direct ERC20 transfer to EOA. **Net latest caller profit = not established.** Do not equate router receipts with EOA income. Separate Oct 29 tx `0xbdbccd790b60c08c73a8b2d65d3342540863001a8d26f137f56cfd2404d69cec` also paid router; October 31 is most recent *identified*, not established latest overall.

## 20 indexed distinct protocols

| # | Protocol | Chain | Function | Contract | Evidence / qualification status |
|---:|---|---|---|---|---|
| 1 | [Beefy Finance](https://docs.beefy.finance/developer-documentation/strategy-contract) | Ethereum | `harvest()` | `0xDEF1be4D80a990847f8C7A1e15e824fF2749C0DE` | transaction reward observed profit unresolved |
| 2 | Convex Finance | Ethereum | `earmarkRewards(pid)` | `0xF403C135812408BFbE8713b5A23a04b3D48AAE31` | incentive config verified latest payout unverified |
| 3 | [Aura Finance](https://docs.aura.finance/) | Ethereum | `earmarkRewards(pid)` | `0xA57b8d98dAE62B26Ec3bcC4a365338157060B234` | incentive config verified latest payout unverified |
| 4 | SMRT Protocol | Ethereum | `harvest()` | `0xDbA0a3E042b1365a76ee1e8Cbd95eaEB2B561AFC` | callability verified latest payout unverified |
| 5 | Stake DAO | Ethereum | `harvest / incentive distribution` | Unverified | contract target unverified |
| 6 | Llama Airforce | Ethereum | `harvest` | Unverified | contract target unverified |
| 7 | [Harbor Finance](https://docs.harborfinance.io/tech-docs/contracts/stability-pool-manager/) | Ethereum | `harvest(bountyReceiver,minBounty)` | `0xE39165aDE355988EFb24dA4f2403971101134CAB` | documented bounty latest payout unverified |
| 8 | Suno Protocol | Ethereum (deployment unconfirmed) | `harvest` | Unverified | documented bounty contract target unverified |
| 9 | Infinite Trading | Optimism / Base | `harvest` | Unverified | documented bounty contract target unverified |
| 10 | STRC | Ethereum | `swapAndDistribute / harvest` | Unverified | documented bounty contract target unverified |
| 11 | [Yeeldx](https://docs.yeeldx.com/products/vaults) | Ethereum / Arbitrum | `harvest` | Unverified | documented bounty contract target unverified |
| 12 | Solid Lizard Finance | Arbitrum | `reinvest` | `0xf4ffe5e59f0B29b77b71eBFb1135F138403ACa2A` | historical bounty event only |
| 13 | [Based Ape Gang](https://basedapes.wtf/docs/vault) | Base | `vault buy execution` | Unverified | documented bounty contract target unverified |
| 14 | Quiver Protocol | Robinhood Chain (unsupported) | `caller-bounty fee collection` | Unverified | excluded unsupported chain |
| 15 | [Kerf](https://www.kerf.finance/docs/vaults) | Robinhood Chain (unsupported) | `harvest / rebalance` | Unverified | excluded unsupported chain |
| 16 | [Caliper](https://www.caliper.finance/docs/) | Robinhood Chain (unsupported) | `harvest / rebalance` | Unverified | excluded unsupported chain |
| 17 | [Levee](https://levee.trade/docs/vaults) | Robinhood Chain (unsupported) | `harvest / rebalance` | Unverified | excluded unsupported chain |
| 18 | Arrowfarm | Robinhood Chain (unsupported) | `harvest` | Unverified | excluded unsupported chain |
| 19 | [EigenYield](https://www.eigenyield.me/keepers) | Robinhood Chain (unsupported) | `harvest(tokens)` | `0xb6e54f359A4F03EB02De3D75e267c7A0ea403006` | excluded unsupported chain |
| 20 | [Nest](https://makeanest.fun/docs) | Robinhood Chain (unsupported) | `claim-vault harvest` | `0xf89E4cb135758DED3E56Ab5d0C57aB5EF863fc04` | excluded unsupported chain |

## Individual research notes

**1. Beefy Finance** — 2026-10-31 tx 0x874fe63b9c29cacecf940c0adfbd123057c1949d839737cbb2ce5a2adc299ea0: 0.000034028401462443 WETH transferred strategy→calling router 0xbc6dbe2c5f172bbb736aa58cfa9bfcb20c85ffe2; gas spent 0.000049463206763321 ETH by EOA 0xd5e87f1f003f222188cc8c5aeefc8b285738b7e7. No direct ERC20 receipt to EOA; router also received CRV and crvUSD in composite transaction. Cannot determine beneficial ownership, attributed payout, or total transaction profit. [Documentation](https://docs.beefy.finance/developer-documentation/strategy-contract)

**2. Convex Finance** — Hub earmarkIncentive() returned 50; no last-seven-day payout tx confirmed.

**3. Aura Finance** — Hub earmarkIncentive() returned 50; no last-seven-day payout tx confirmed. [Documentation](https://docs.aura.finance/)

**4. SMRT Protocol** — YieldDeployer harvest() eth_call succeeded; documented keeper incentive (1%), actual recent payment not established.

**5. Stake DAO** — Prior research indicates public harvest incentive; must locate active fee-paying target.

**6. Llama Airforce** — Prior research indicates 1% caller incentive; no deployed target or payout established.

**7. Harbor Finance** — Documented harvest bounty paid to bountyReceiver; contract mapping is preliminary, must establish this manager live and fee paying. [Documentation](https://docs.harborfinance.io/tech-docs/contracts/stability-pool-manager/)

**8. Suno Protocol** — Public audit describes harvester bounty; current chain/address/payment not established.

**9. Infinite Trading** — Vault docs describe harvest caller remuneration; live vault address/payment unverified.

**10. STRC** — Documentation references keeper bounty; live deployed target and recent payout unverified.

**11. Yeeldx** — Docs mention native-token harvest call fee on certain strategies; current vault/payment unverified. [Documentation](https://docs.yeeldx.com/products/vaults)

**12. Solid Lizard Finance** — Historically emitted Reinvest caller/bounty event; no fresh payout established.

**13. Based Ape Gang** — Docs describe permissionless bounty for next vault buy; deployed target and last payment not verified. [Documentation](https://basedapes.wtf/docs/vault)

**14. Quiver Protocol** — Reported call incentives; Hub currently lacks Robinhood Chain.

**15. Kerf** — Docs specify 0.5% vault harvest caller bounty; unsupported Hub network. [Documentation](https://www.kerf.finance/docs/vaults)

**16. Caliper** — Docs specify policy caller bounties; unsupported Hub network. [Documentation](https://www.caliper.finance/docs/)

**17. Levee** — Docs specify 0.5% vault harvest fee to caller; unsupported Hub network. [Documentation](https://levee.trade/docs/vaults)

**18. Arrowfarm** — Reported keeper fee mechanism; unsupported Hub network.

**19. EigenYield** — Docs promise 0.002 ETH harvest first-caller tip; unsupported Hub network. [Documentation](https://www.eigenyield.me/keepers)

**20. Nest** — Docs specify 1% claim-vault harvest bounty (0.02 ETH cap), contract listed is claim-vault generation, not necessarily an individual deployed claim vault; unsupported Hub network. [Documentation](https://makeanest.fun/docs)

## Qualification rules and unresolved access

A qualifying record requires: public callable function; **timestamped on-chain payout in the seven-day window**; receipt/transfers to actual caller or verified operator; exact reward token and decimals; gas used and effective gas price; and **net realized value** (with token price and any execution expenses) for the latest caller. Every record currently lacks at least one of these. Incentive settings, ABI presence, simulated eth_call and historical events do not count as 7-day payout evidence. Unsupported networks are excluded from Hub-qualified list.

Hub Ethereum RPC and transaction inspection returned 200, but indexed address histories returned `EXPLORER_UNAVAILABLE` 502; wide event ranges returned public RPC 429 and private RPC 400. Do not interpret failed lookup as absence of payments. The records are a **screening queue**, not an automated-executable opportunity list.

Machine-readable companion: `callable-reward-protocols-v1.json` (content version v2).
