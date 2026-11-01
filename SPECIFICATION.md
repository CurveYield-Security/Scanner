# Morpho Liquidation Scanner — Functional Specification

**Document version:** v7  
**Status:** Requirements specification  
**Repository:** `CurveYield-Security/Scanner`  
**Scope:** Morpho Blue market discovery, 90-day liquidation indexing, and harvestable-market analysis  
**Architecture constraint:** Exactly three workflows. This document specifies their responsibilities and interfaces; it does not authorize trading or on-chain transactions.

---

## 1. Purpose and operating model

The Scanner identifies Morpho Blue markets where liquidation events repeatedly remain executable for one or more blocks before a liquidator acts. It reports those markets as potential harvesting opportunities and estimates the liquidation reward's current USDC value by requesting a DEX-aggregator quote.

The system has exactly three workflows:

1. **Market Discovery** — enumerate Morpho Blue markets and discover positions that are currently liquidatable or forecast to become liquidatable within a configurable horizon.
2. **Liquidation Event Indexer** — index all Morpho Blue liquidation events in the trailing 90-day period and maintain the historical event dataset.
3. **Harvestable Market Analyzer** — determine the first executable block for each indexed liquidation, calculate its block delay, identify markets with repeated delayed events, and quote each event's liquidation reward into USDC.

There is no fourth workflow, trading bot, transaction executor, dashboard service, or separate profitability workflow in this scope. Shared code and data schemas may be used by the three workflows; they do not constitute additional workflows.

### 1.1 Core defaults

| Setting | Default | Meaning |
|---|---:|---|
| Historical lookback | 90 days | Liquidation-event window |
| Minimum delayed events | 2 | Minimum qualifying events per market within the lookback |
| Forward risk horizon | 30 days | Forecast window for positions approaching liquidation |
| Profit quote output | USDC | Target token for liquidation-reward quotes |
| Profit quote source | KyberSwap Aggregator API | Initial quote provider; provider adapter should permit a replacement if coverage or access changes |
| Execution | Disabled | Read-only analysis; no transactions are sent |

The minimum delayed-event threshold is a count, not a percentage: a market qualifies when it has at least two qualifying delayed liquidation events in the configured 90-day window.

---

## 2. Workflow 1 — Market Discovery

### 2.1 Objective

Build and maintain a catalogue of Morpho Blue markets across every chain on which Morpho Blue is deployed, and discover market positions that are:

- Liquidatable at the latest verified state; or
- Projected to become liquidatable within the configured forward horizon (30 days by default).

The discovery process must not assume that a fixed list of chains is exhaustive. It must identify Morpho Blue deployments from authoritative Morpho deployment/registry information and verify discovered deployments on-chain.

### 2.2 Market discovery functions

1. **Discover supported deployments**
   - Retrieve the authoritative Morpho Blue deployment/registry information and supported chain identifiers.
   - Verify each deployment address and chain ID against on-chain code.
   - Record source and last verification block/time.
   - Do not silently treat a missing RPC endpoint as proof that a chain has no deployment; report it as an unavailable chain.

2. **Enumerate markets**
   - Enumerate every market for each verified deployment using the supported Morpho market registry/indexing interface.
   - Verify market identifiers and core parameters against on-chain state.
   - Record at minimum:
     - Chain ID and chain name
     - Morpho Blue contract address
     - Market ID
     - Loan token and collateral token addresses
     - Oracle address
     - Interest Rate Model (IRM) address
     - LLTV
     - Market creation/first-seen block and timestamp, where available
     - Latest verified state block and timestamp
     - Market activity/status metadata, where available
   - Preserve token decimals and symbols as metadata; addresses and raw integer amounts remain canonical.

3. **Discover risky positions**
   - Prefer Morpho's own indexed position/market-position data where it exposes the frontend's risk or health-factor information.
   - Investigate and use the Morpho GraphQL market-position query (including health-factor filtering) as the primary candidate-discovery route if it is available and sufficiently complete.
   - The public REST interface must not be assumed to provide a complete list of all Blue positions. If the indexed GraphQL source is unavailable, incomplete, rate-limited, or unsuitable, record that limitation and use an on-chain/indexed fallback rather than silently omitting positions.
   - Revalidate every candidate against the corresponding on-chain market and borrower state at a recorded block.
   - Classify candidates as:
     - `currently_liquidatable`
     - `forecast_liquidatable_within_horizon`
     - `not_currently_liquidatable`
     - `unknown_insufficient_data`

4. **Forecast approaching liquidation**
   - Use current collateral/debt position state, current oracle price, market LLTV, and the market's interest-accrual mechanics.
   - Project debt growth under the current applicable rate assumptions and calculate the estimated time at which the position reaches Morpho's liquidation eligibility threshold, assuming the oracle price remains unchanged.
   - The default horizon is 30 days and must be configurable.
   - This is a deterministic scenario projection, not a price prediction. It must explicitly state the constant-oracle-price assumption and must not claim to predict future collateral prices.
   - A position whose projected threshold crossing is within the horizon is a forward-risk candidate. Positions already eligible must be reported separately, not as future forecasts.
   - Use Morpho's exact liquidation eligibility rules, share/asset conversions, oracle scaling, and rounding behavior. Do not approximate eligibility with a generic health-factor threshold if it can produce different results from the contract.

### 2.3 Position data fields

For each discovered candidate, store where available:

- Chain ID, market ID, borrower address
- Collateral and loan token addresses
- Collateral shares/assets and debt shares/assets
- Oracle address, latest oracle price and its source block
- LLTV and relevant market parameters
- Health factor / liquidation eligibility result
- Candidate classification
- Estimated time and block horizon to eligibility, if forecast
- Projection assumptions and calculation version
- Data source, observation timestamp, and verified block number
- Completeness/confidence status and any reason for uncertainty

### 2.4 Refresh and outputs

- Support a full initial market catalogue and incremental refreshes.
- Refresh active-market and risky-position data on a configurable schedule.
- Recheck candidates against fresh on-chain state before publishing them as currently liquidatable.
- Retain historical snapshots needed to compare changes in position risk.
- Expose a machine-readable market catalogue and current/forward-risk candidate dataset for Workflows 2 and 3.

### 2.5 Workflow 1 failure handling

- A failed chain, registry, API, or RPC request must be recorded with chain/source/block context.
- Retry transient failures with bounded backoff and rate-limit awareness.
- Never convert missing data into an empty market or position set.
- Record pagination cursors and checkpoints so discovery can resume without skipping results.
- Clearly identify chains and markets whose discovery coverage is incomplete.

### 2.6 Chain-scoped runs, reports, and reuse

- Every manual run must require one EVM chain ID. A run processes that chain only; it must not silently expand to other chains.
- The forward-risk horizon is a run parameter, defaulting to 30 days.
- Each run must produce a human-readable Markdown report and a machine-readable JSON dataset containing the collected market and position-candidate records, source provenance, timestamps, configuration, and coverage status.
- Store the latest pair and immutable per-run snapshots under `data/market-discovery/{chain_id}/`:
  - `latest.md` and `latest.json`
  - `snapshots/{UTC timestamp}.md` and `snapshots/{UTC timestamp}.json`
- The JSON document is the canonical input for later workflows. The Markdown document is its human-readable companion.
- Reuse the saved market catalogue when it is within its configured cache lifetime; refresh dynamic position-risk candidates on every run. A force-refresh input must bypass the market cache.
- If a refresh fails, retain the last successful dataset where available, mark it stale, and record the failure. Never present stale data as a fresh successful scan.
- Do not discard older snapshots when writing a new latest report.

### 2.7 Market Discovery implementation status

The current implementation is Market Discovery collector v10 and workflow v6.

**Collection and persistence**
- One run is scoped to one required EVM chain ID.
- Morpho REST `GET /v1/blue/markets` is cursor-paginated to enumerate the selected chain's indexed Blue market catalogue.
- Morpho GraphQL `marketPositions` is paginated without a health-factor cutoff to retain the full position inventory exposed by the index for that chain.
- Each run writes `latest.md`, `latest.json`, and immutable timestamped Markdown/JSON snapshots under `data/market-discovery/{chain_id}/`.
- JSON contains the full indexed position inventory, market catalogue, token metadata, on-chain market risk contexts, risk-evaluation results, source provenance, block context, configuration, and coverage status. Markdown includes the complete market catalogue, on-chain market risk contexts, evaluated risk candidates, and the indexed position inventory.
- The market catalogue is reused for 24 hours unless forced to refresh. Token metadata is reused; unavailable metadata is retried on subsequent runs. Immutable market-parameter verification is reused after a successful on-chain check. Position inventory and risk state are refreshed each run.
- If market or position-index refresh fails, the previous saved dataset is retained and marked stale/incomplete rather than reported as a fresh empty result.
- A repository-wide concurrency group serializes report commits so simultaneous chain runs cannot race while updating the shared repository.
- Dependencies are pinned in package.json; the first workflow run creates and commits package-lock.json, and subsequent runs install from that lockfile with npm ci.

**On-chain validation and risk calculations**
- The Morpho Blue singleton address is resolved by chain ID from Morpho's maintained `@morpho-org/morpho-ts` address registry. Its bytecode is checked at the target chain.
- Each market ID is checked against `keccak256(abi.encode(MarketParams))`; market parameters are then verified against the singleton's `idToMarketParams`. Verified immutable parameters are retained for later runs.
- The workflow reads Morpho market state, oracle price, and candidate borrower positions at a recorded latest block.
- Current health is evaluated with Morpho Blue's exact core rounding direction: borrow shares convert to debt assets rounding up; collateral value and LLTV borrowing capacity round down.
- Existing unaccrued interest is simulated with Morpho's `wTaylorCompounded` formula and the market IRM's `borrowRateView`.
- Forward eligibility uses a conditional scenario with the current oracle price and current borrow rate held constant over the configured horizon. The earliest threshold-crossing second is found by integer binary search. This is a scenario projection, not a collateral-price forecast or a guarantee of future eligibility.
- To limit expensive individual position RPC reads, the indexed health factor is used as a conservative prefilter: candidates at or below the modelled debt-growth factor plus a 5% margin are individually verified on-chain. The complete indexed position inventory remains in both reports; positions outside the prefilter are not individually on-chain evaluated in that run.

**Coverage qualifications**
- Morpho GraphQL does not expose its indexer lag in the position response. The full set of rows returned by the index is retained, but the result cannot claim the index is synchronized with the latest block.
- GraphQL uses offset pagination. Concurrent index updates can shift rows between pages; duplicates are deduplicated and unique row totals are compared with the API-reported total. Missing totals or a unique-row discrepancy are explicitly marked as incomplete pagination.
- Candidate prefiltering means the on-chain evaluation set is not the entire borrower universe. The report distinguishes indexed inventory from positions individually verified and classified.
- If the selected chain has no Morpho SDK deployment address, no valid RPC, no Morpho bytecode, or missing market/oracle/IRM state, the affected records are reported as unavailable or the run fails before publishing misleading results.
- An optional GitHub Actions secret named `MORPHO_RPC_URL` can supply a read-only RPC endpoint. Otherwise the workflow discovers a public endpoint and verifies its `eth_chainId` before reading.
- No wallet, signing key, transaction submission, contract deployment, or on-chain write path is present.

This implementation materially advances the functional requirements but does not claim perfect global position completeness: source index freshness and the indexed-health-factor prefilter remain explicit limits.
---

## 3. Workflow 2 — Liquidation Event Indexer

### 3.1 Objective

Build a complete, resumable dataset of Morpho Blue liquidation events over the trailing 90 days for every discovered deployment/market.

### 3.2 Event indexing functions

1. Consume the verified deployment and market catalogue from Workflow 1.
2. Determine the block range corresponding to the trailing 90 days on each chain.
3. Query Morpho Blue liquidation logs using the correct deployed contract ABI and chain-specific deployment address.
4. Decode and persist every liquidation event, preserving raw event/log data as well as normalized fields.
5. Backfill historical events in bounded block ranges and continue incrementally from the last confirmed checkpoint.
6. Reconcile checkpoints and block hashes to detect chain reorganizations; remove or supersede orphaned log records and reprocess the affected range.
7. Deduplicate by chain ID, transaction hash, and log index.
8. Preserve events even when later analysis cannot reconstruct the exact executable block or quote a reward.

### 3.3 Required event fields

At minimum:

- Chain ID and Morpho Blue deployment address
- Market ID
- Borrower address
- Liquidator address
- Transaction hash and log index
- Block number, block hash, and block timestamp
- Debt/loan assets repaid (raw integer and normalized amount)
- Collateral shares/assets seized (raw integer and normalized amount)
- Loan and collateral token addresses and decimals
- Raw decoded event payload
- Indexing source, indexed-at timestamp, and canonicality status

The implementation must use the actual event ABI and exact event semantics for the deployed Morpho Blue version. Field names in storage must not imply a value is available if the event does not contain it; any additional value reconstructed from state must be marked as reconstructed.

### 3.4 Coverage and completeness

- The lookback is based on chain timestamps, not a single assumed block rate.
- Block-range pagination must be resumable and rate-limit aware.
- Store per-chain start/end blocks, completed ranges, and last canonical checkpoint.
- Verify that indexed ranges are contiguous before marking a chain's 90-day backfill complete.
- Reconcile indexed event counts against available authoritative indexed sources where possible, without treating a third-party indexer as the canonical record.
- A chain with missing historical access or incomplete ranges must be marked incomplete, not complete with zero events.

### 3.5 Workflow 2 outputs

- Canonical normalized liquidation-event dataset.
- Raw event/log dataset for audit and re-decoding.
- Per-chain indexing checkpoints and coverage status.
- Market-level event counts over the configured lookback.
- A stable event identifier used by Workflow 3.

---

## 4. Workflow 3 — Harvestable Market Analyzer

### 4.1 Objective

Identify markets with recurring non-same-block liquidation opportunities and report every qualifying event, its exact block delay from first executable eligibility, and the USDC quote for the liquidation reward tokens.

A market is **harvestable under this scanner's historical rule** when at least two liquidation events in the trailing 90 days are confirmed to have become executable before the block in which they were liquidated.

This is a historical opportunity signal, not a guarantee that a future liquidation will remain available or profitable.

### 4.2 Reconstruct first executable block

For every indexed liquidation event:

1. Identify the borrower, market, and liquidation transaction.
2. Reconstruct the relevant market, borrower position, and oracle state at historical blocks preceding the liquidation.
3. Apply Morpho's exact liquidation eligibility and liquidation amount rules, including LLTV, oracle scaling, accrued interest, share/asset conversions, and contract rounding.
4. Find the earliest block at which a liquidation transaction could have succeeded under the on-chain state and protocol rules.
5. Confirm that the position remained eligible through the actual liquidation block, or represent any intervening ineligible period as a separate eligibility episode.
6. Compare the first executable block with the actual liquidation block.

The analyzer must distinguish:
- **First observed eligible block:** earliest block for which available reconstructed state shows eligibility.
- **First executable block:** earliest block for which the liquidation call could actually satisfy the contract's conditions and execute successfully.
- **Liquidation block:** block containing the indexed liquidation transaction.

Do not equate an unhealthy/low health-factor observation with executable liquidation unless the protocol's actual call conditions are met. Where historical state, oracle data, or required transaction context is missing, mark the event `unknown` or `lower_bound_only`; do not fabricate an exact executable block.

### 4.3 Delay calculation

For each event with a confirmed first executable block:

`delay_blocks = liquidation_block_number - first_executable_block_number`

- A result of `0` means the liquidation occurred in the same block in which it first became executable and is not a delayed event.
- A result greater than `0` is a delayed liquidation and counts toward the market's two-event threshold.
- Report elapsed seconds as a secondary metric using the timestamps of the relevant blocks. Block count is the primary requested measure.
- Do not infer intra-block ordering from block numbers alone. If eligibility and liquidation occur in the same block, use transaction ordering/state immediately before the liquidation transaction where the available historical data permits. Otherwise mark intra-block ordering as unresolved.
- Preserve the first executable block, evidence method, confidence, and calculation version for every result.

### 4.4 Harvestable-market qualification

- Default analysis window: trailing 90 days.
- Default qualification threshold: at least **2 confirmed delayed liquidation events per market** in that window.
- Only events with `delay_blocks > 0` and a sufficiently supported first executable block count toward the threshold.
- Same-block events are retained in event-level output and market statistics, but do not count toward qualification.
- Events with unknown or lower-bound-only timing are reported separately and do not count toward the confirmed threshold.
- The threshold and lookback must be configurable without changing code.
- Report the delayed-event count, total event count, delayed-event ratio, average/median delay, and timing coverage for each market.

### 4.5 Liquidation reward and USDC quote calculation

The objective is to estimate what the liquidation reward tokens for each historical event would quote to in USDC **at the time the analyzer runs**. The user does not want an estimate of what the original liquidator actually realized, nor a reconstruction of their later swaps or holdings.

For each qualifying delayed event:

1. Reconstruct the collateral amount seized and the debt amount repaid using the event and verified transaction state.
2. Calculate the liquidator's protocol liquidation reward/incentive token amount using Morpho's exact liquidation math for that market and event. Do not treat the entire seized collateral principal as profit. The reward is the incentive portion attributable to liquidation, not the value of all collateral transferred.
3. Request a swap quote for that reward-token amount into USDC on the same chain.
4. Record the aggregator's quoted USDC output as the event's **estimated current gross reward value**.
5. Do not subtract gas, flash-loan fees, or hypothetical execution costs from the headline value. The requested headline is the USDC quote itself. If later desired, such costs can be shown as separate optional context, not deducted from this metric.

**Initial quote provider:** KyberSwap Aggregator API, subject to confirming supported chains, token pairs, current API terms, and rate limits during implementation. The provider interface should be replaceable so another aggregator can be used if Kyber does not support a chain or token. No API key is assumed to be required; use the documented client identification/header mechanism if applicable. Do not commit credentials or private keys to the repository.

**Quote semantics:**
- Quotes are current quotes requested at analysis time for the historical event's reward-token quantity. They are not historical prices at the liquidation block.
- Use the exact chain ID, reward-token address, token decimals, input amount, and USDC token address for that chain.
- Request a route/quote that represents executable swap output, not a spot-price lookup.
- Record quote timestamp, provider, route identifier/details when available, quoted USDC output, input amount, quote status, and any provider error.
- Apply sensible quote freshness and slippage/route constraints supported by the provider. Do not silently accept stale, zero, partial, or failed quotes as valid profit values.
- If the reward amount is zero, the token is unsupported, no route exists, or the quote fails, retain the event and mark the quote unavailable with a reason.
- Do not substitute a quote from another chain or assume bridged USDC is equivalent without an explicit supported route.
- Do not aggregate missing quotes as zero.

**Terminology:** The USDC quote is an estimate of the current gross value of the protocol liquidation reward. It is not proof of realized profit, net profit, or a guaranteed future execution price.

### 4.6 Required event-level analyzer output

For every indexed event, including non-qualifying and same-block events, retain:

- Stable event ID, chain, market ID, borrower, and liquidator
- Transaction hash, liquidation block, and timestamp
- First observed eligible block, if known
- First executable block, if established
- Delay in blocks and elapsed seconds
- Timing classification: `same_block`, `delayed`, `unknown`, or `lower_bound_only`
- Evidence/confidence and missing-data reason
- Debt repaid and collateral seized
- Reward token address and calculated reward amount
- USDC quote amount, quote timestamp, aggregator, route metadata, and quote status
- Calculation and quote-provider versions

### 4.7 Required market-level output

For every market with at least two confirmed delayed events, publish:

- Chain and market identity (market ID, loan token, collateral token, LLTV, oracle)
- Total indexed liquidations in the 90-day window
- Confirmed delayed liquidation count
- Same-block liquidation count
- Unknown/unresolved timing count
- Delayed-event percentage among events with resolved timing
- Average, median, minimum, and maximum delay in blocks
- Average/median elapsed seconds
- Per-event current USDC reward quote
- Sum of available USDC quotes and number of events with valid quotes
- Data coverage and quote coverage indicators

The market report must contain a list of every delayed event that contributed to qualification, not merely summary statistics. It should also retain same-block and unresolved events in separate lists or fields so the user can assess the full sample.

### 4.8 Ranking

Rank qualifying markets using transparent, separately displayed measures rather than an opaque score. Primary ordering should favor:
1. More confirmed delayed events;
2. Higher median and average delay in blocks;
3. Higher current USDC reward quote totals and per-event values;
4. Better timing and quote coverage.

Show the underlying values used for ordering. Do not allow a high quoted reward total from one event to conceal a market with only two delayed events or poor data coverage.

### 4.9 Re-analysis and quote refresh

- Reconstruct timing from the indexed historical data and persist calculation results with a version.
- Refresh USDC quotes independently of event indexing so current reward-token values can be updated without re-indexing the chain.
- Retain quote history or at minimum the latest quote timestamp and result; never present an old quote as current.
- Re-run analysis when market/event data, calculation logic, or configuration changes.
- A failed quote provider must not prevent timing analysis or market qualification.

---

## 5. Data contracts and workflow dependencies

The workflows exchange durable, versioned records. A shared database or storage layer may be selected during implementation, but the workflows remain exactly three independently runnable jobs.

| Producer | Output | Consumer |
|---|---|---|
| Workflow 1 | Deployment and market catalogue | Workflows 2 and 3 |
| Workflow 1 | Current/forward-risk position candidates | Workflow 3 and future discovery refreshes |
| Workflow 2 | Canonical liquidation event records and checkpoints | Workflow 3 |
| Workflow 3 | Event timing, reward calculations, USDC quotes, harvestable-market reports | User-facing reports/export |

Records must include chain IDs and contract/token addresses. Symbols and names are display metadata only and must never be used as unique identifiers.

All persisted datasets must include source provenance, observation/indexing time, relevant block number/hash, schema version, and calculation version where applicable.

---

## 6. Execution, scheduling, and resource boundaries

- Implement exactly three GitHub Actions workflows, one corresponding to each section above.
- Each workflow must be independently runnable and resumable.
- Workflow 1 must be able to refresh market discovery and forward-risk candidates without requiring a full historical re-index.
- Workflow 2 must be able to backfill the initial 90-day period and then index incrementally.
- Workflow 3 must be able to re-run timing analysis and refresh quotes without re-fetching every historical event.
- Heavy historical reconstruction may use GitHub-hosted runner compute. Durable data must live in persistent storage, not only in ephemeral runner files or workflow artifacts.
- Use bounded chunks, checkpoints, retries, and rate-limit handling. A workflow run completing is not proof that every chain/range was processed; publish explicit coverage/completion state.
- Do not place API keys, RPC credentials, private keys, or other secrets in source files, committed configuration, logs, or public artifacts. Use repository/environment secrets for credentials if required.
- All chain access in this scope is read-only. No wallet signing, transaction submission, liquidation execution, token approvals, or contract deployment.

---

## 7. Configuration

The following settings should be externally configurable:

- Chain/deployment allowlist or denylist, with automatic discovery as the default behavior
- Historical lookback days (default 90)
- Minimum delayed events per market (default 2)
- Forward-risk horizon days (default 30)
- Discovery/indexing chunk sizes and request pacing
- RPC/indexer/GraphQL endpoints and credentials, where required
- USDC token address per supported chain
- Aggregator provider and client identification
- Quote freshness and route constraints
- Workflow schedules and manual run parameters

Configuration changes must be recorded with the resulting analysis so reports can be reproduced.

---

## 8. Accuracy requirements and explicit limitations

1. **Executable means executable:** eligibility must be evaluated against Morpho's actual contract rules and historical state, not inferred solely from a frontend badge or health-factor estimate.
2. **No invented timing:** if the first executable block cannot be established, report unknown or a lower bound.
3. **No false market qualification:** only two or more confirmed delayed events qualify by default.
4. **No false profit claims:** USDC output is a current aggregator quote for the calculated reward amount, not historical realized profit or guaranteed net profit.
5. **Reward math must be exact:** use the deployed Morpho implementation's liquidation calculations and rounding behavior.
6. **Coverage must be visible:** missing chains, failed ranges, incomplete pagination, and unavailable historical state must be explicit.
7. **Reorganizations must be handled:** event records and checkpoints must track canonical block hashes.
8. **Forward estimates are conditional:** the 30-day projection assumes unchanged oracle price unless an explicitly documented alternative scenario is added.
9. **Frontend/indexer data is a discovery aid:** verify candidate positions and market parameters against on-chain state before classifying them.
10. **No trading:** this specification covers discovery and analysis only.

---

## 9. Acceptance outcomes (functional, not a test authorization)

When implemented and run successfully, the system should produce:

- A cross-chain Morpho Blue market catalogue with verification and coverage metadata.
- A current and 30-day-forward list of liquidation-risk positions, with assumptions stated.
- A canonical, resumable trailing-90-day liquidation-event index.
- For each event with sufficient historical data, the first executable block and exact block delay to liquidation.
- A list of markets with at least two confirmed delayed events in the 90-day window.
- For every delayed event in each qualifying market, the calculated liquidation reward token amount and its current KyberSwap (or configured replacement aggregator) USDC quote.
- Clear unresolved/unsupported cases rather than fabricated values.

This is the complete v1 functional scope for the three-workflow Morpho Liquidation Scanner.
