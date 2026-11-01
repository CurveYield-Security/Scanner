# Morpho Liquidation Scanner — Functional Specification

**Document version:** v16  
**Status:** Requirements specification  
**Repository:** `CurveYield-Security/Scanner`  
**Scope:** Independent Morpho Blue market discovery and direct chain-wide liquidation analysis  
**Architecture constraint:** Exactly three workflows. This document specifies their responsibilities and interfaces; it does not authorize trading or on-chain transactions.

---

## 1. Purpose and operating model

The Scanner identifies Morpho Blue markets where liquidation events repeatedly remain executable for one or more blocks before a liquidator acts. It reports those markets as potential harvesting opportunities and estimates the liquidation reward's current USDC value by requesting a DEX-aggregator quote.

The system has exactly two independent workflows:

1. **Market Discovery** — enumerate Morpho Blue markets and discover positions that are currently liquidatable or forecast to become liquidatable within a configurable horizon. Its output is a standalone risk report; it does not feed the analyzer.
2. **Market Analyzer** — query the shared Morpho Blue singleton's chain-wide `Liquidate` event stream directly, process each event individually, determine readiness-to-execution delay, and calculate gross liquidation surplus only for events with a positive delay.

There is no liquidation event indexer, market-catalogue handoff, trading bot, transaction executor, dashboard service, or separate profitability workflow. Each workflow runs independently.

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
- Expose a machine-readable market catalogue and current/forward-risk candidate dataset for standalone discovery reporting. The Market Analyzer does not consume this output.

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
- The JSON document is the canonical Market Discovery output. The Markdown document is its human-readable companion; neither is an input dependency for the Market Analyzer.
- Reuse the saved market catalogue when it is within its configured cache lifetime; refresh dynamic position-risk candidates on every run. A force-refresh input must bypass the market cache.
- If a refresh fails, retain the last successful dataset where available, mark it stale, and record the failure. Never present stale data as a fresh successful scan.
- Do not discard older snapshots when writing a new latest report.

### 2.7 Market Discovery implementation status

The current implementation is Market Discovery collector v19 and workflow v7.

**Collection and persistence**
- One run is scoped to one required EVM chain ID.
- Morpho REST `GET /v1/blue/markets` is cursor-paginated to enumerate the selected chain's indexed Blue market catalogue.
- Morpho GraphQL `marketPositions` is paginated without a health-factor cutoff to retain the full position inventory exposed by the index for that chain.
- Each run writes `latest.md`, `latest.json`, and immutable timestamped Markdown/JSON snapshots under `data/market-discovery/{chain_id}/`.
- JSON contains the full indexed position inventory, all on-chain position assessments, the market catalogue, token metadata, on-chain market risk contexts, risk-candidate shortlist, source provenance, block context, configuration, and coverage status. Markdown includes the complete market catalogue, token metadata, on-chain market risk contexts, detailed risk candidates, and the full indexed position inventory with current and projected assessments.
- The Markdown report starts with a ranked shortlist of up to 10 markets containing currently liquidatable, forecast-liquidatable, or unknown-risk positions. Each row groups positions by market and reports current/forecast/unknown counts and the earliest projected crossing; individual position details remain below.
- Market Discovery does not produce liquidation-indexer input files. Morpho Blue markets are IDs within one shared singleton per chain; the Market Analyzer resolves each market ID directly from the singleton when decoding chain-wide events.
- The market catalogue is reused for 24 hours unless forced to refresh. Token metadata is reused; unavailable metadata is retried on subsequent runs. Immutable market-parameter verification is reused after a successful on-chain check. Position inventory and risk state are refreshed each run.
- If market or position-index refresh fails, the previous saved dataset is retained and marked stale/incomplete rather than reported as a fresh empty result.
- A repository-wide concurrency group serializes report commits so simultaneous chain runs cannot race while updating the shared repository.
- Dependencies are pinned in package.json; the first workflow run creates and commits package-lock.json, and subsequent runs install from that lockfile with npm ci.

**On-chain validation and risk calculations**
- The Morpho Blue singleton address is resolved by chain ID from Morpho's maintained `@morpho-org/morpho-ts` address registry. Its bytecode is checked at the target chain.
- Each market ID is checked against `keccak256(abi.encode(MarketParams))`; market parameters are then verified against the singleton's `idToMarketParams`. Verified immutable parameters are retained for later runs.
- The workflow reads Morpho market state, oracle price, and candidate borrower positions at one recorded latest block. Every on-chain call, including market-parameter checks, market state, oracle, IRM, and positions, is pinned to that same block number. It uses Multicall3 for batched reads where available and falls back to bounded individual read calls if the multicall path is unavailable.
- Current health is evaluated with Morpho Blue's exact core rounding direction: borrow shares convert to debt assets rounding up; collateral value and LLTV borrowing capacity round down.
- Existing unaccrued interest is simulated with Morpho's `wTaylorCompounded` formula and the market IRM's `borrowRateView`.
- Forward eligibility uses a conditional scenario with the current oracle price and current borrow rate held constant over the configured horizon. The earliest threshold-crossing second is found by integer binary search. This is a scenario projection, not a collateral-price forecast or a guarantee of future eligibility.
- Every position returned by Morpho GraphQL is individually read from the Morpho singleton. Position reads are batched through Multicall3 in groups of 250 where available, with bounded individual-call fallback. The complete indexed inventory and each on-chain assessment are retained in JSON; Markdown shows the complete inventory and the current/forecast/unknown risk shortlist.

**Coverage qualifications**
- Morpho GraphQL does not expose its indexer lag in the position response. The full set of rows returned by the index is retained, but the result cannot claim the index is synchronized with the latest block.
- GraphQL uses offset pagination. Concurrent index updates can shift rows between pages; duplicates are deduplicated and unique row totals are compared with the API-reported total. Missing totals or a unique-row discrepancy are explicitly marked as incomplete pagination.
- The on-chain evaluation set covers every borrower returned by the Morpho GraphQL inventory. The report still cannot guarantee that the index itself contains every current chain position or is synchronized to the latest block.
- If the selected chain has no Morpho SDK deployment address, no valid RPC, no Morpho bytecode, or missing market/oracle/IRM state, the affected records are reported as unavailable or the run fails before publishing misleading results.
- The workflow selects a read-only RPC secret by chain ID: `RPC_KATANA` for Katana (747474) and `RPC_ETHEREUM` for Ethereum (1). The RPC chain ID is verified before reading.
- No wallet, signing key, transaction submission, contract deployment, or on-chain write path is present.

This implementation materially advances the functional requirements but does not claim perfect global position completeness: source index freshness and offset-pagination consistency remain explicit limits.
---

## 3. Workflow 2 — Direct Chain-Wide Market Analyzer

### 3.1 Objective

Query Morpho Blue's shared singleton directly for every `Liquidate` event in the trailing 90-day window. Process events individually to determine how long each liquidation remained executable before execution. Calculate profit only for events where the readiness-to-execution delay is positive.

There is no separate event indexer. The analyzer does not consume Market Discovery output or iterate through a market catalogue. The singleton event stream is chain-wide; each event carries its market ID.

### 3.2 Chain-wide event query

- Resolve the Morpho Blue singleton for the selected chain and verify deployed bytecode.
- Query `Liquidate(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)` logs from that singleton.
- Filter by event signature only; leave indexed market-ID topic unrestricted so all markets are included.
- Decode topic 1 as market ID, topic 2 as caller/liquidator, and topic 3 as borrower.
- Derive the 90-day start block from block timestamps, not an assumed block rate.
- Query bounded block ranges, shrink ranges when the RPC rejects them, deduplicate by transaction hash and log index, and preserve event ordering.
- Resolve each event's market parameters directly from the singleton's `idToMarketParams(marketId)`. No Market Discovery catalogue is required.
- Preserve raw event values, transaction hash, log index, block number/hash, timestamp, market ID, borrower, liquidator, repaid assets/shares, seized assets, and bad-debt fields.

### 3.3 Readiness-to-execution timing

For each liquidation event, independently reconstruct the borrower's eligibility in historical blocks preceding execution:

- Read market state, borrower position, oracle price, and applicable IRM rate at the historical block.
- Apply Morpho's debt-share-to-asset rounding, interest accrual, oracle scaling, and LLTV eligibility calculation.
- Find the earliest supported block at which the position was eligible, then compare it with the liquidation block.
- Record block delay as the primary metric and elapsed seconds as a secondary metric.
- A zero-block delay is same-block or unresolved intra-block ordering. It is not a delayed event.
- A positive block delay is a delayed event.
- If the historical search limit is reached while the position remains eligible, preserve a positive lower-bound delay and label it `lower_bound_only`.
- If historical reads fail or eligibility cannot be reconstructed, label the event `unknown`; never invent a readiness block.

The current implementation brackets the earliest eligible block with exponential lookback and binary search. This assumes eligibility does not reverse inside the bracket; oracle movements can violate that assumption. The report must expose this assumption and distinguish boundary estimates from lower-bound and unknown results. Do not describe the result as an execution simulation: it is a historical state-based eligibility reconstruction.

### 3.4 Conditional profit calculation

Profit calculation is strictly conditional:

- Do not calculate profit for same-block, zero-delay, or unknown-timing events.
- Calculate gross liquidation surplus only when a positive delay is established, including positive lower-bound-only delays.
- Use the event's seized collateral amount, repaid debt amount, and market oracle price at the execution boundary to calculate collateral value in the loan token, then subtract debt repaid.
- Report gross surplus in raw and decimal-adjusted loan-token units.
- If the loan token is the configured chain USDC token, also report the same value as USDC. Do not imply that a non-USDC loan-token amount is a USDC quote.
- Do not calculate profit on any other liquidation event.
- Label the result as gross oracle-valued surplus, not realized net profit. Gas, financing, slippage, and execution costs are not included.

### 3.5 RPC pacing and recovery

All JSON-RPC HTTP requests made by either workflow must pass through the shared adaptive limiter:

- Start at 10 requests per second.
- After more than three consecutive failed RPC requests (four failures), pause for 3 seconds, reduce the sustained rate by 1 request per second, and resume.
- The minimum rate is 1 request per second.
- A successful RPC response resets the consecutive-failure counter.
- Serialize request starts through one limiter so concurrent application tasks cannot bypass the aggregate rate.
- Apply the limiter to retries as well as initial requests. Never log RPC URLs or credentials.

### 3.6 Analyzer outputs

Write a machine-readable JSON report and a human-readable Markdown report under `data/market-analysis/{chain_id}/`, including immutable per-run snapshots. Retain every liquidation event and its timing classification. Only positive-delay events may contain a `profit` object. Report total event counts, delayed counts, same-block/unresolved counts, lower-bound-only counts, unknown counts, the historical block range, assumptions, and coverage.

---
## 5. Data contracts and workflow dependencies

The two workflows are independent and produce separate durable, versioned reports. There is no workflow-to-workflow data dependency.

| Producer | Output | Consumer |
|---|---|---|
| Workflow 1 — Market Discovery | Market catalogue and current/forward-risk position reports | Standalone discovery output |
| Workflow 2 — Market Analyzer | Chain-wide liquidation event timing and conditional gross-surplus analysis | Standalone analyzer output |

Records must include chain IDs and contract/token addresses. Symbols and names are display metadata only and must never be used as unique identifiers.

All persisted datasets must include source provenance, observation/indexing time, relevant block number/hash, schema version, and calculation version where applicable.

---

## 6. Execution, scheduling, and resource boundaries

- Implement exactly two GitHub Actions workflows, one for Market Discovery and one for the Market Analyzer.
- Each workflow must be independently runnable and resumable.
- Workflow 1 must be able to refresh market discovery and forward-risk candidates without requiring a full historical re-index.
- Workflow 2 must be able to query the trailing 90-day chain-wide singleton event stream directly on each run.
- Workflow 2 must perform timing analysis and conditional profit calculation in the same run; it must not depend on Workflow 1 or a separate event indexer.
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
- USDC token address per supported chain
- Quote freshness and route constraints
- Workflow schedules and manual run parameters

Configuration changes must be recorded with the resulting analysis so reports can be reproduced.

---

## 8. Accuracy requirements and explicit limitations

1. **Executable means executable:** eligibility must be evaluated against Morpho's actual contract rules and historical state, not inferred solely from a frontend badge or health-factor estimate.
2. **No invented timing:** if the first executable block cannot be established, report unknown or a lower bound.
3. **No false market qualification:** only two or more confirmed delayed events qualify by default.
4. **No false profit claims:** USDC output is a current aggregator quote for the calculated reward amount, not historical realized profit or guaranteed net profit.
5. **Profit calculation is conditional:** only events with a positive readiness-to-execution delay receive a gross-surplus calculation.
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
- A trailing-90-day chain-wide liquidation event report generated directly from the Morpho singleton.
- For each event with sufficient historical data, the first executable block and exact block delay to liquidation.
- A list of markets with at least two confirmed delayed events in the 90-day window.
- For every event with a positive readiness-to-execution delay, a gross-surplus calculation in the market loan token, with USDC denomination only when that loan token is the configured USDC token.
- Clear unresolved/unsupported cases rather than fabricated values.

This is the v1 functional scope for the two-workflow Morpho Liquidation Scanner.
