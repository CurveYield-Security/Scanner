# Callable Reward Protocol Scan — v1

**Scope:** public smart-contract calls that pay the caller for useful protocol maintenance/yield realization. Explicitly excluded: borrower liquidations and DEX arbitrage/trading.

**Chain order:** Ethereum → Base → Arbitrum. Arbitrum was selected as the third chain because the research sweep found materially more keeper/harvest infrastructure there than Optimism among the remaining supported chains.

## Verified eligible protocols

| Protocol | Chain | Callable function | Caller reward evidence | Contract / target | Verification |
|---|---|---|---|---|---|
| Beefy Finance | Ethereum | `callReward()` / `harvest()` | Live `callReward()` returned a non-zero value on 2026-11-01 | `0xDEF1be4D80a990847f8C7A1e15e824fF2749C0DE` | Blockchain Operations Hub |
| Convex Finance | Ethereum | `earmarkRewards(pid)` | `earmarkIncentive()` live read = 50 (basis points-style incentive parameter) | `0xF403C135812408BFbE8713b5A23a04b3D48AAE31` Booster | Blockchain Operations Hub + public fee documentation |
| Aura Finance | Ethereum | `earmarkRewards(pid)` | `earmarkIncentive()` live read = 50 | `0xA57b8d98dAE62B26Ec3bcC4a365338157060B234` Booster | Blockchain Operations Hub |
| SMRT Protocol | Ethereum | `harvest()` | Protocol documentation states permissionless harvest with 1% keeper fee; live Hub eth_call to `harvest()` completed without revert | `0xDbA0a3E042b1365a76ee1e8Cbd95eaEB2B561AFC` YieldDeployer | Blockchain Operations Hub + protocol docs |

## High-confidence research candidates requiring contract-level confirmation

| Protocol | Chain | Evidence | Reason not promoted to verified set |
|---|---|---|---|
| Stake DAO | Ethereum | Public research documents a caller incentive on its harvest flow | The currently identified sdCRV token itself is not the harvest contract; a precise live harvest target was not established in this pass |
| Llama Airforce | Ethereum | Public research reports a 1% caller incentive on yield harvesting | Exact current harvest target/address was not established sufficiently for Hub confirmation |

## Excluded / near-miss findings

- Yearn: harvest/report surfaces found, but no sufficiently strong evidence of a public caller bounty on the currently relevant deployments.
- Harvest Finance: harvest fees accrue to the protocol/depositors; no verified public caller bounty found.
- Concentrator / AladdinDAO: harvest exists, but the relevant harvest surface is/was restricted to a harvester role rather than universally public.
- RAAC: harvest bounty exists in the economics, but the documented function requires `HARVEST_ROLE`.
- Sperax legacy CompoundStrategy on Arbitrum: `harvestIncentiveRate()` exists, but the live rate read was **0**, so it is not currently a caller-reward opportunity.
- Quiver Protocol: caller incentive confirmed by current documentation/DeFiLlama methodology, but deployment is on Robinhood Chain, which is not supported by the Blockchain Operations Hub.
- Kerf: permissionless 0.5% harvest bounty confirmed, but deployment is on Robinhood Chain, not a supported Hub chain.
- Caliper: permissionless harvest/re-centre bounty confirmed, but current deployment research points to Robinhood Chain.
- Levee: permissionless harvest/rebalance bounties confirmed, but current deployment research points to Robinhood Chain.
- Arrowfarm: harvest caller fee confirmed, but deployment is Robinhood Chain.
- EticaHub: permissionless harvest with caller tip confirmed, but Etica mainnet is outside the supported Hub networks.
- ZeroTrace: permissionless harvest caller gas reimbursement confirmed, but deployment is outside the supported Hub networks.
- STRC: Ethereum documentation describes permissionless keeper bounties, but the current public docs do not provide the live mainnet contract addresses needed for Hub verification.
- SMRT-like/other experimental projects were not promoted without live contract confirmation.

## Current result

**4 protocols verified on supported chains. 2 additional high-confidence candidates identified.**

The requested 20-protocol target was **not reached without relaxing the scan criteria**. The principal bottleneck is that a large portion of the current 2026 caller-bounty ecosystem is on Robinhood Chain, while the Blockchain Operations Hub currently exposes only Katana, Ethereum, Base, Arbitrum, and Optimism. I did not count unsupported-chain protocols as scanned results or inflate the list with permissioned harvesters/liquidators/arbitrage systems.

## Machine-readable companion

See `callable-reward-protocols-v1.json` for the structured scanner records.
