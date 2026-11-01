// File version: v1
import { createPublicClient, defineChain, formatUnits, http, parseAbiItem, type Address, type Hex } from "viem";
import { getChainAddress } from "@morpho-org/morpho-ts";
import { createAdaptiveRpcFetch } from "./rpc_rate_limiter.js";

const WAD = 10n ** 18n;
const PRICE_SCALE = 10n ** 36n;
const VA = 1n, VS = 10n ** 6n;
const PARAMS = [
  { name: "loanToken", type: "address" }, { name: "collateralToken", type: "address" },
  { name: "oracle", type: "address" }, { name: "irm", type: "address" }, { name: "lltv", type: "uint256" },
] as const;
const MORPHO_ABI = [
  { type: "function", name: "idToMarketParams", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "params", type: "tuple", components: PARAMS }] },
  { type: "function", name: "market", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "market", type: "tuple", components: [
    { name: "totalSupplyAssets", type: "uint128" }, { name: "totalSupplyShares", type: "uint128" },
    { name: "totalBorrowAssets", type: "uint128" }, { name: "totalBorrowShares", type: "uint128" },
    { name: "lastUpdate", type: "uint128" }, { name: "fee", type: "uint128" },
  ] }] },
  { type: "function", name: "position", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }, { name: "user", type: "address" }], outputs: [{ name: "position", type: "tuple", components: [
    { name: "supplyShares", type: "uint256" }, { name: "borrowShares", type: "uint128" }, { name: "collateral", type: "uint128" },
  ] }] },
] as const;
const IRM_ABI = [{ type: "function", name: "borrowRateView", stateMutability: "view", inputs: [
  { name: "marketParams", type: "tuple", components: PARAMS },
  { name: "market", type: "tuple", components: [
    { name: "totalSupplyAssets", type: "uint128" }, { name: "totalSupplyShares", type: "uint128" },
    { name: "totalBorrowAssets", type: "uint128" }, { name: "totalBorrowShares", type: "uint128" },
    { name: "lastUpdate", type: "uint128" }, { name: "fee", type: "uint128" },
  ] },
], outputs: [{ name: "rate", type: "uint256" }] }] as const;
const ORACLE_ABI = [{ type: "function", name: "price", stateMutability: "view", inputs: [], outputs: [{ name: "price", type: "uint256" }] }] as const;
const ERC20_ABI = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;
const LIQUIDATE = parseAbiItem("event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function down(x: bigint, y: bigint, d: bigint) { return x * y / d; }
function up(x: bigint, y: bigint, d: bigint) { return (x * y + d - 1n) / d; }
function wm(x: bigint, y: bigint) { return down(x, y, WAD); }
function taylor(rate: bigint, seconds: bigint) {
  const a = rate * seconds, b = down(a, a, 2n * WAD), c = down(b, a, 3n * WAD);
  return a + b + c;
}
function assetsUp(shares: bigint, assets: bigint, totalShares: bigint) {
  return up(shares, assets + VA, totalShares + VS);
}
function asNum(x: bigint) { return Number(x); }

async function findStartBlock(client: any, latest: bigint, lookbackDays: number) {
  const latestBlock = await client.getBlock({ blockNumber: latest });
  const target = latestBlock.timestamp - BigInt(lookbackDays) * 86400n;
  let lo = 0n, hi = latest;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp < target) lo = mid + 1n; else hi = mid;
  }
  return { block: lo, timestamp: target, latestTimestamp: latestBlock.timestamp };
}

async function collectLogs(client: any, morpho: Address, from: bigint, to: bigint) {
  const all: any[] = [];
  let cursor = from, span = 5000n, rangeFailures = 0;
  while (cursor <= to) {
    const end = cursor + span - 1n > to ? to : cursor + span - 1n;
    try {
      const logs = await client.getLogs({ address: morpho, event: LIQUIDATE, fromBlock: cursor, toBlock: end });
      all.push(...logs);
      rangeFailures = 0;
      cursor = end + 1n;
      if (span < 5000n) span = span * 2n > 5000n ? 5000n : span * 2n;
    } catch (error) {
      const message = String(error).toLowerCase();
      if (/429|rate.?limit|too many requests|throughput|compute units|-32005/.test(message)) {
        rangeFailures++;
        if (rangeFailures >= 5) throw new Error("RPC rate limit persisted after five bounded retries at block " + cursor + ": " + String(error));
        console.warn("RPC rate limit at block " + cursor + "; retaining range and backing off (attempt " + rangeFailures + "/5)");
        await sleep(Math.min(3000 * rangeFailures, 15000));
        continue;
      }
      rangeFailures = 0;
      if (span <= 1n) throw new Error("eth_getLogs failed at block " + cursor + ": " + String(error));
      span = span / 2n;
      console.warn("Log range rejected; reducing block span to " + span);
      await sleep(250);
    }
  }
  const dedup = new Map<string, any>();
  for (const log of all) dedup.set(String(log.transactionHash) + ":" + String(log.logIndex), log);
  return [...dedup.values()].sort((a, b) => a.blockNumber === b.blockNumber
    ? Number(a.logIndex - b.logIndex) : a.blockNumber < b.blockNumber ? -1 : 1);
}

async function main() {
  const chainId = Number(process.env.CHAIN_ID ?? "747474");
  const lookbackDays = Number(process.env.LOOKBACK_DAYS ?? "90");
  const rpcUrl = process.env.RPC_URL;
  const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());
  const usdc = (process.env.USDC_TOKEN_ADDRESS ?? "").toLowerCase();
  const maxLookbackBlocks = BigInt(process.env.MAX_READINESS_LOOKBACK_BLOCKS ?? "50000");
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isSafeInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 365 || !Number.isSafeInteger(minDelayedEvents) || minDelayedEvents < 1 || minDelayedEvents > 100) throw new Error("Invalid chain, lookback, or delayed-event threshold");
  if (!rpcUrl) throw new Error("Missing configured RPC secret (RPC_KATANA or RPC_ETHEREUM)");
  const morpho = (chainId === 747474 ? "0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc" : getChainAddress(chainId, "blue")) as Address;
  const chain = defineChain({ id: chainId, name: chainId === 747474 ? "Katana" : "Chain " + chainId,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 60000, retryCount: 2, fetchFn: createAdaptiveRpcFetch() }) });
  if (await client.getChainId() !== chainId) throw new Error("RPC chain ID does not match workflow input");
  const morphoCode = await client.getBytecode({ address: morpho });
  if (!morphoCode || morphoCode === "0x") throw new Error("Morpho Blue singleton has no deployed bytecode on this chain");

  const latest = await client.getBlockNumber();
  const range = await findStartBlock(client, latest, lookbackDays);
  const logs = await collectLogs(client, morpho, range.block, latest);
  const paramsCache = new Map<string, any>();
  const eligibilityCache = new Map<string, boolean>();
  const decimalsCache = new Map<string, number>();
  const results: any[] = [];

  async function marketParams(id: Hex) {
    const key = id.toLowerCase();
    if (!paramsCache.has(key)) {
      const p = await client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [id] });
      paramsCache.set(key, p);
    }
    return paramsCache.get(key);
  }

  async function eligibleAt(id: Hex, borrower: Address, blockNumber: bigint, p: any): Promise<boolean> {
    const key = id.toLowerCase() + ":" + borrower.toLowerCase() + ":" + blockNumber;
    if (eligibilityCache.has(key)) return eligibilityCache.get(key)!;
    const [state, pos, price, block] = await Promise.all([
      client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "market", args: [id], blockNumber }),
      client.readContract({ address: morpho, abi: MORPHO_ABI, functionName: "position", args: [id, borrower], blockNumber }),
      client.readContract({ address: p.oracle, abi: ORACLE_ABI, functionName: "price", blockNumber }),
      client.getBlock({ blockNumber }),
    ]) as any[];
    if (pos.borrowShares === 0n || pos.collateral === 0n) { eligibilityCache.set(key, false); return false; }
    let accrued = state.totalBorrowAssets;
    if (state.lastUpdate > 0n && block.timestamp > state.lastUpdate && state.totalBorrowAssets > 0n &&
        p.irm.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
      const rate = await client.readContract({ address: p.irm, abi: IRM_ABI, functionName: "borrowRateView", args: [p, state], blockNumber });
      accrued += wm(state.totalBorrowAssets, taylor(rate, block.timestamp - state.lastUpdate));
    }
    const debt = assetsUp(pos.borrowShares, accrued, state.totalBorrowShares);
    const collateralValue = down(pos.collateral, price, PRICE_SCALE);
    const maxDebt = wm(collateralValue, p.lltv);
    const eligible = maxDebt < debt;
    eligibilityCache.set(key, eligible);
    return eligible;
  }

  async function readiness(id: Hex, borrower: Address, liquidationBlock: bigint, p: any) {
    if (liquidationBlock === 0n) return { status: "same_block_or_unresolved", first_eligible_block: null, delay_blocks: 0 };
    const before = liquidationBlock - 1n;
    if (!await eligibleAt(id, borrower, before, p)) return { status: "same_block_or_unresolved", first_eligible_block: null, delay_blocks: 0 };
    let eligibleBlock = before, healthyBlock: bigint | null = null, step = 1n;
    while (step <= maxLookbackBlocks) {
      const probe = before > step ? before - step : 0n;
      if (!await eligibleAt(id, borrower, probe, p)) { healthyBlock = probe; break; }
      eligibleBlock = probe;
      if (probe === 0n) break;
      step *= 2n;
    }
    if (healthyBlock === null) return { status: "lower_bound_only", first_eligible_block: eligibleBlock.toString(), delay_blocks: Number(liquidationBlock - eligibleBlock), search_limit_blocks: maxLookbackBlocks.toString() };
    let lo = healthyBlock + 1n, hi = eligibleBlock;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (await eligibleAt(id, borrower, mid, p)) hi = mid; else lo = mid + 1n;
    }
    return { status: "delayed", first_eligible_block: lo.toString(), delay_blocks: Number(liquidationBlock - lo), search_method: "exponential_bracket_then_binary_search", monotonicity_assumption: "eligibility is assumed not to revert during the bracket; oracle movements may violate this assumption" };
  }

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const a: any = log.args;
    const id = a.id as Hex, borrower = a.borrower as Address, caller = a.caller as Address;
    const eventBlock = await client.getBlock({ blockNumber: log.blockNumber });
    const p: any = await marketParams(id);
    const item: any = {
      chain_id: chainId, morpho_singleton: morpho, market_id: id, borrower, liquidator: caller,
      transaction_hash: log.transactionHash, transaction_index: Number(log.transactionIndex), log_index: Number(log.logIndex),
      block_hash: log.blockHash, raw_log: { topics: log.topics, data: log.data },
      liquidation_block: Number(log.blockNumber), liquidation_timestamp: Number(eventBlock.timestamp),
      market_params: { loan_token: p.loanToken, collateral_token: p.collateralToken, oracle: p.oracle, irm: p.irm, lltv_raw: p.lltv.toString() },
      repaid_assets_raw: a.repaidAssets.toString(), repaid_shares_raw: a.repaidShares.toString(),
      seized_assets_raw: a.seizedAssets.toString(), bad_debt_assets_raw: a.badDebtAssets.toString(),
      timing_status: "unknown", first_eligible_block: null, delay_blocks: null, delay_seconds: null,
      profit_calculated: false,
    };
    try {
      const timing = await readiness(id, borrower, log.blockNumber, p);
      item.timing_status = timing.status;
      item.first_eligible_block = timing.first_eligible_block;
      item.delay_blocks = timing.delay_blocks;
      item.timing_method = timing.search_method ?? "checked_immediately_before_liquidation";
      item.timing_limit_blocks = timing.search_limit_blocks ?? null;
      item.monotonicity_assumption = timing.monotonicity_assumption ?? null;
      if (["delayed", "lower_bound_only"].includes(timing.status) && timing.first_eligible_block !== null && timing.delay_blocks > 0) {
        const firstBlock = await client.getBlock({ blockNumber: BigInt(timing.first_eligible_block) });
        item.delay_seconds = Number(eventBlock.timestamp - firstBlock.timestamp);
        try {
          const priceBlock = log.blockNumber;
          const oraclePrice = await client.readContract({ address: p.oracle, abi: ORACLE_ABI, functionName: "price", blockNumber: priceBlock });
          const collateralValueInLoan = down(a.seizedAssets, oraclePrice, PRICE_SCALE);
          const grossProfit = collateralValueInLoan - a.repaidAssets;
          const loanKey = String(p.loanToken).toLowerCase();
          if (!decimalsCache.has(loanKey)) decimalsCache.set(loanKey, Number(await client.readContract({ address: p.loanToken, abi: ERC20_ABI, functionName: "decimals", blockNumber: priceBlock })));
          const loanDecimals = decimalsCache.get(loanKey)!;
          item.profit_calculated = true;
          item.profit = { method: "oracle_value_of_collateral_seized_minus_debt_repaid", loan_token: p.loanToken, loan_token_decimals: loanDecimals, gross_profit_loan_token_raw: grossProfit.toString(), gross_profit_loan_token: formatUnits(grossProfit, loanDecimals), oracle_price_raw: oraclePrice.toString(),
            oracle_observation_block: priceBlock.toString(),
            oracle_price_timing: "liquidation_block_end_state", usdc_token_address: usdc || null, gross_profit_usdc_raw: usdc && p.loanToken.toLowerCase() === usdc ? grossProfit.toString() : null, gross_profit_usdc: usdc && p.loanToken.toLowerCase() === usdc ? formatUnits(grossProfit, loanDecimals) : null, usdc_conversion_status: usdc && p.loanToken.toLowerCase() === usdc ? "loan_token_is_configured_usdc" : "not_converted", excludes_gas_and_execution_costs: true, warning: "Gross oracle-valued surplus, not realized net profit. Oracle price is read at liquidation block-end, not at the exact transaction index. USDC value is populated only when the market loan token is the configured USDC token." };
        } catch (profitError) { item.profit_error = String(profitError); }
      }
    } catch (error) {
      item.analysis_error = String(error);
      item.timing_status = "unknown";
    }
    results.push(item);
    if ((i + 1) % 25 === 0) console.log("Processed " + (i + 1) + "/" + logs.length + " liquidation events");
  }

  const delayed = results.filter(x => ["delayed", "lower_bound_only"].includes(x.timing_status) && x.delay_blocks > 0);
  const report = {
    schema_version: "1.0.0", document_version: "v1", workflow: "market_analyzer",
    chain: { chain_id: chainId, morpho_blue_singleton: morpho },
    generated_at: new Date().toISOString(),
    configuration: { lookback_days: lookbackDays, max_readiness_lookback_blocks: maxLookbackBlocks.toString(), initial_rpc_requests_per_second: 10, failure_backoff: "after_more_than_3_consecutive_failures_pause_3_seconds_and_reduce_rate_by_1_per_second_floor_1", usdc_token_address: usdc || null },
    coverage: { from_block: range.block.toString(), to_block: latest.toString(), event_count: logs.length, delayed_event_count: delayed.length, same_block_or_unresolved_count: results.filter(x => x.timing_status === "same_block_or_unresolved").length, lower_bound_only_count: results.filter(x => x.timing_status === "lower_bound_only").length, unknown_count: results.filter(x => x.timing_status === "unknown").length },
    events: results,
    profit_policy: "Profit is calculated only for events with a positive supported block delay, including positive lower bounds. All other liquidation events retain timing records but have no profit calculation.",
    limitations: ["The readiness search uses exponential bracketing and binary search, assuming eligibility does not reverse within the bracket. Oracle price movements can violate that assumption; results expose the assumption and should not be treated as exact proof where oracle history is volatile.", "The profit figure is gross collateral value at the market oracle minus debt repaid, denominated in the loan token. It is not realized net profit and excludes gas and execution costs.", "USDC conversion is only populated when the loan token itself is the configured USDC token; other loan tokens remain denominated in their loan token."],
  };

  const fs = await import("node:fs/promises"), path = await import("node:path");
  const root = "data/market-analysis/" + chainId, snapshots = path.join(root, "snapshots");
  await fs.mkdir(snapshots, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "") + "-run-" + runId;
  const md = [
    "# Morpho Blue Market Analyzer — Chain " + chainId, "",
    "- Generated: " + report.generated_at, "- Lookback: " + lookbackDays + " days",
    "- Morpho singleton: " + morpho, "- Liquidation events: " + logs.length,
    "- Delayed events: " + delayed.length, "",
    "## Delayed liquidation events", "",
    "| Market ID | Borrower | Tx | Liquidation block | First eligible block | Delay blocks | Delay seconds | Gross profit (loan token raw) |",
    "|---|---|---|---:|---:|---:|---:|---:|",
    ...delayed.map(x => "| " + x.market_id + " | " + x.borrower + " | " + x.transaction_hash + " | " + x.liquidation_block + " | " + x.first_eligible_block + " | " + x.delay_blocks + " | " + (x.delay_seconds ?? "unknown") + " | " + (x.profit?.gross_profit_loan_token_raw ?? "unavailable") + " |"),
    "", "## Coverage", "", JSON.stringify(report.coverage, null, 2), "",
    "## Profit policy", "", report.profit_policy, "", "## Limitations", "", ...report.limitations.map(x => "- " + x), "",
  ].join("\n");
  await fs.writeFile(path.join(root, "latest.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(root, "latest.md"), md, "utf8");
  await fs.writeFile(path.join(snapshots, stamp + ".json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(snapshots, stamp + ".md"), md, "utf8");
  console.log(JSON.stringify({ chain_id: chainId, event_count: logs.length, delayed_event_count: delayed.length, latest_json: path.join(root, "latest.json"), latest_markdown: path.join(root, "latest.md") }, null, 2));
}
main().catch(error => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
