#!/usr/bin/env python3
"""Market Discovery implementation v2: chain-scoped collection and durable snapshots."""
from __future__ import annotations
import datetime as dt
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.morpho.org"
GRAPHQL = API + "/graphql"
SCHEMA_VERSION = "1.0.0"
MARKET_CACHE_HOURS = 24
PAGE_SIZE = 1000
MAX_PAGES = 1000
DEFAULT_HF_CUTOFF = 1.25

def utc_now():
    return dt.datetime.now(dt.timezone.utc)

def request_json(url, method="GET", body=None, attempts=5):
    payload = None if body is None else json.dumps(body).encode()
    headers = {"accept": "application/json", "user-agent": "curveyield-morpho-scanner/1.0"}
    if payload is not None:
        headers["content-type"] = "application/json"
    for attempt in range(attempts):
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            retry_after = exc.headers.get("Retry-After")
            if exc.code not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                raise RuntimeError(f"HTTP {exc.code} for {url}: {exc.read(500).decode(errors='replace')}") from exc
            time.sleep(int(retry_after) if retry_after and retry_after.isdigit() else min(2 ** attempt, 30))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == attempts - 1:
                raise RuntimeError(f"Request failed for {url}: {exc}") from exc
            time.sleep(min(2 ** attempt, 30))
    raise RuntimeError("Request exhausted retries: " + url)

def fetch_markets(chain_id):
    cursor, rows = None, {}
    for page in range(MAX_PAGES):
        params = {"chain_id": str(chain_id), "limit": str(PAGE_SIZE)}
        if cursor:
            params["cursor"] = cursor
        result = request_json(API + "/v1/blue/markets?" + urllib.parse.urlencode(params))
        data = result.get("data")
        if not isinstance(data, list):
            raise RuntimeError("Morpho market-list response omitted data array")
        for item in data:
            if isinstance(item, dict) and int(item.get("chain_id", -1)) == chain_id:
                market_id = str(item.get("market_id", "")).lower()
                if market_id:
                    rows[market_id] = item
        cursor = result.get("cursor")
        if not cursor:
            return sorted(rows.values(), key=lambda x: str(x.get("market_id", "")))
        if page == MAX_PAGES - 1:
            raise RuntimeError("Market pagination safety limit reached; refusing partial catalogue")
    return []

POSITION_QUERY = """
query MarketPositions($chainIds: [Int!], $hfLte: Float!, $first: Int!, $skip: Int!) {
  marketPositions(
    where: { chainId_in: $chainIds, healthFactor_lte: $hfLte }
    orderBy: HealthFactor
    orderDirection: Asc
    first: $first
    skip: $skip
  ) {
    pageInfo { count countTotal }
    items { healthFactor market { marketId } user { address } }
  }
}
"""

def fetch_risk_candidates(chain_id, hf_cutoff=DEFAULT_HF_CUTOFF):
    skip, rows, raw_count = 0, {}, 0
    for page in range(MAX_PAGES):
        body = {"query": POSITION_QUERY, "variables": {
            "chainIds": [chain_id], "hfLte": hf_cutoff, "first": PAGE_SIZE, "skip": skip}}
        result = request_json(GRAPHQL, method="POST", body=body)
        if result.get("errors"):
            raise RuntimeError("Morpho GraphQL error: " + json.dumps(result["errors"][:2]))
        page_data = (result.get("data") or {}).get("marketPositions") or {}
        items = page_data.get("items")
        if not isinstance(items, list):
            raise RuntimeError("GraphQL response omitted marketPositions.items")
        page_info = page_data.get("pageInfo") or {}
        if isinstance(page_info.get("count"), int) and page_info["count"] != len(items):
            raise RuntimeError("GraphQL page count did not match returned item count")
        raw_count += len(items)
        for item in items:
            market = item.get("market") or {}
            user = item.get("user") or {}
            market_id = str(market.get("marketId", "")).lower()
            borrower = str(user.get("address", "")).lower()
            if market_id and borrower:
                key = market_id + ":" + borrower
                hf = item.get("healthFactor")
                rows[key] = {
                    "market_id": market_id,
                    "borrower": borrower,
                    "health_factor": hf,
                    "source": "Morpho GraphQL marketPositions",
                    "source_classification": (
                        "api_reports_currently_liquidatable"
                        if isinstance(hf, (int, float)) and hf <= 1
                        else "api_reports_near_liquidation"
                    ),
                    "onchain_verified": False,
                    "forward_projection": "unknown_insufficient_data"
                }
        skip += len(items)
        total = page_info.get("countTotal")
        if len(items) < PAGE_SIZE or (isinstance(total, int) and skip >= total):
            return sorted(rows.values(), key=lambda x: (x["market_id"], x["borrower"])), {
                "raw_rows": raw_count, "unique_candidates": len(rows), "pages": page + 1,
                "health_factor_cutoff": hf_cutoff, "pagination_complete": True}
        if not items:
            break
    raise RuntimeError("Position pagination safety limit reached; refusing partial candidate set")

def read_previous(path):
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None

def render_markdown(report):
    coverage, markets, candidates = report["coverage"], report["markets"], report["risk_candidates"]
    chain = report["chain"]
    lines = [
        f"# Morpho Blue Market Discovery — Chain {chain['chain_id']}",
        "",
        "- **Document version:** v1",
        f"- **Run timestamp (UTC):** {report['run_timestamp']}",
        f"- **Forward-risk horizon requested:** {report['configuration']['forward_horizon_days']} days",
        f"- **Market catalogue:** {coverage['market_catalogue_status']}",
        f"- **Risk candidate scan:** {coverage['risk_candidate_status']}",
        "",
        "## Summary",
        "",
        f"- Markets catalogued: **{len(markets)}**",
        f"- Morpho risk candidates: **{len(candidates)}**",
        f"- API-reported health factor at or below 1.0: **{sum(1 for x in candidates if isinstance(x.get('health_factor'), (int, float)) and x['health_factor'] <= 1)}**",
        "- Candidates verified on-chain: **0**",
        "",
        "## Interpretation and limitations",
        "",
        "The public Morpho REST API supports cursor-paginated Blue market discovery. It does not expose a market-wide list of Blue borrower positions, so risk candidates are sourced from Morpho's GraphQL marketPositions index.",
        "",
        f"The requested {report['configuration']['forward_horizon_days']}-day horizon is recorded, but this initial implementation does not claim a deterministic forward liquidation projection. Exact projection requires current on-chain position and market state, oracle values, and Morpho's interest-accrual and rounding rules. Candidates are therefore marked unknown_insufficient_data until that verification path is implemented.",
        "",
        "The GraphQL candidate query is limited to health factor <= 1.25. It is a near-risk candidate feed, not a claim that every position on the chain has been enumerated.",
        "",
        "## Cache and coverage",
        "",
        f"- Market catalogue status: {coverage['market_catalogue_status']}",
        f"- Last market fetch: {coverage.get('market_catalogue_fetched_at') or 'unknown'}",
        f"- Reused prior market catalogue: {coverage['market_catalogue_reused']}",
        f"- Market refresh error: {coverage.get('market_refresh_error') or 'none'}",
        f"- Candidate pagination complete: {coverage['candidate_pagination_complete']}",
        f"- Candidate data stale: {coverage.get('candidate_data_stale', False)}",
        f"- Candidate scan error: {coverage.get('candidate_scan_error') or 'none'}",
        f"- Candidate rows received: {coverage['candidate_raw_rows']}",
        f"- Candidate pages: {coverage['candidate_pages']}",
        "",
        "## Market catalogue",
        "",
        "| Market ID | Loan token | Collateral token | Oracle | IRM | LLTV (WAD) | Creation block |",
        "|---|---|---|---|---|---:|---:|",
    ]
    for m in markets:
        lines.append("| {0} | {1} | {2} | {3} | {4} | {5} | {6} |".format(
            m.get("market_id", ""), m.get("loan_token", ""), m.get("collateral_token", ""),
            m.get("oracle_address", ""), m.get("irm_address", ""), m.get("lltv_wad", ""),
            m.get("creation_block_number", "")))
    lines += ["", "## Risk candidates", "",
              "| Market ID | Borrower | Health factor | API classification | On-chain status |",
              "|---|---|---:|---|---|"]
    for c in candidates:
        hf = c.get("health_factor")
        lines.append(f"| {c['market_id']} | {c['borrower']} | {hf if hf is not None else 'unknown'} | {c['source_classification']} | unverified |")
    lines += [
        "", "## Sources",
        "",
        "- Morpho Blue REST: GET https://api.morpho.org/v1/blue/markets with chain_id and cursor pagination.",
        "- Morpho GraphQL: POST https://api.morpho.org/graphql, marketPositions scoped to the selected chain.",
        "- Token symbols and decimals are not inferred; token addresses remain canonical identifiers.",
        "- Read-only discovery. No wallet, signing, transaction submission, or contract deployment.",
        ""
    ]
    return "\n".join(lines)

def main():
    try:
        chain_id = int(os.environ["CHAIN_ID"])
        horizon = int(os.environ.get("FORWARD_HORIZON_DAYS", "30"))
        force = os.environ.get("FORCE_MARKET_REFRESH", "false").lower() == "true"
    except (KeyError, ValueError) as exc:
        raise SystemExit(f"Invalid workflow inputs: {exc}")
    if chain_id <= 0 or not 1 <= horizon <= 365:
        raise SystemExit("chain_id must be positive; forward horizon must be 1-365 days")

    root = pathlib.Path("data") / "market-discovery" / str(chain_id)
    root.mkdir(parents=True, exist_ok=True)
    latest_path = root / "latest.json"
    previous = read_previous(latest_path)
    now = utc_now()
    previous_at = (previous or {}).get("coverage", {}).get("market_catalogue_fetched_at")
    cache_fresh = False
    if previous_at and not force:
        try:
            cached_at = dt.datetime.fromisoformat(previous_at.replace("Z", "+00:00"))
            cache_fresh = (now - cached_at).total_seconds() < MARKET_CACHE_HOURS * 3600
        except ValueError:
            pass

    market_error = None
    if cache_fresh and previous and isinstance(previous.get("markets"), list):
        markets, reused, markets_at, market_status = previous["markets"], True, previous_at, "reused_cached_catalogue"
    else:
        try:
            markets = fetch_markets(chain_id)
            reused = False
            markets_at = now.isoformat().replace("+00:00", "Z")
            market_status = "refreshed"
        except Exception as exc:
            market_error = str(exc)
            if previous and isinstance(previous.get("markets"), list):
                markets, reused, markets_at = previous["markets"], True, previous_at
                market_status = "stale_cache_after_refresh_failure"
            else:
                markets, reused, markets_at = [], False, None
                market_status = "failed_no_catalogue"

    candidate_error = None
    try:
        candidates, meta = fetch_risk_candidates(chain_id)
        candidate_status = "complete_for_configured_health_factor_cutoff_unverified_onchain"
        candidate_stale = False
    except Exception as exc:
        candidate_error = str(exc)
        candidates = (previous or {}).get("risk_candidates", [])
        old_cov = (previous or {}).get("coverage", {})
        meta = {
            "raw_rows": old_cov.get("candidate_raw_rows", 0),
            "unique_candidates": len(candidates),
            "pages": old_cov.get("candidate_pages", 0),
            "health_factor_cutoff": old_cov.get("candidate_health_factor_cutoff", DEFAULT_HF_CUTOFF),
            "pagination_complete": False
        }
        candidate_status = "failed_using_previous_snapshot" if candidates else "failed_no_candidate_data"
        candidate_stale = bool(candidates)
    report = {
        "schema_version": SCHEMA_VERSION,
        "document_version": "v1",
        "workflow": "market_discovery",
        "chain": {"chain_id": chain_id, "name": None},
        "run_timestamp": now.isoformat().replace("+00:00", "Z"),
        "configuration": {
            "forward_horizon_days": horizon,
            "market_catalogue_cache_hours": MARKET_CACHE_HOURS,
            "candidate_health_factor_cutoff": meta["health_factor_cutoff"]
        },
        "coverage": {
            "market_catalogue_status": market_status,
            "market_catalogue_fetched_at": markets_at,
            "market_catalogue_reused": reused,
            "market_refresh_error": market_error,
            "risk_candidate_status": candidate_status,
            "candidate_data_stale": candidate_stale,
            "candidate_scan_error": candidate_error,
            "candidate_pagination_complete": meta["pagination_complete"],
            "candidate_raw_rows": meta["raw_rows"],
            "candidate_pages": meta["pages"],
            "candidate_unique_count": meta["unique_candidates"],
            "candidate_health_factor_cutoff": meta["health_factor_cutoff"],
            "onchain_verification_status": "not_implemented",
            "forward_projection_status": "unknown_insufficient_data"
        },
        "markets": markets,
        "risk_candidates": candidates,
        "sources": [
            {"name": "Morpho Blue REST API", "endpoint": "/v1/blue/markets", "role": "market_catalogue"},
            {"name": "Morpho GraphQL API", "endpoint": "/graphql", "role": "risk_candidate_discovery"}
        ],
        "previous_document": "latest.json" if previous else None,
        "markdown_report": "latest.md"
    }
    markdown = render_markdown(report)
    latest_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (root / "latest.md").write_text(markdown, encoding="utf-8")
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    snapshots = root / "snapshots"
    snapshots.mkdir(exist_ok=True)
    (snapshots / f"{stamp}.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (snapshots / f"{stamp}.md").write_text(markdown, encoding="utf-8")
    print(json.dumps({
        "chain_id": chain_id, "markets": len(markets), "risk_candidates": len(candidates),
        "market_catalogue_reused": reused,
        "latest_json": str(latest_path), "latest_markdown": str(root / "latest.md"),
        "snapshot_prefix": str(snapshots / stamp),
        "onchain_verification": "not_implemented",
        "forward_projection": "unknown_insufficient_data"
    }, indent=2))

if __name__ == "__main__":
    main()
