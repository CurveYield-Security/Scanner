import { createPublicClient, defineChain, encodeAbiParameters, getAddress, http, keccak256, type Address, type Hex } from "viem";
import { getChainAddress, ChainUtils } from "@morpho-org/morpho-ts";

const API = "https://api.morpho.org";
const PAGE = 1000, MAX_PAGES = 10000, CACHE_HOURS = 24;
const WAD = 10n ** 18n, PRICE_SCALE = 10n ** 36n, VS = 10n ** 6n, VA = 1n;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
let morphoNextRequestAt = 0;
const PARAMS = [
  {name:"loanToken",type:"address"},{name:"collateralToken",type:"address"},
  {name:"oracle",type:"address"},{name:"irm",type:"address"},{name:"lltv",type:"uint256"}
] as const;
const MORPHO_ABI = [
 {type:"function",name:"idToMarketParams",stateMutability:"view",inputs:[{name:"id",type:"bytes32"}],outputs:[{name:"params",type:"tuple",components:PARAMS}]},
 {type:"function",name:"market",stateMutability:"view",inputs:[{name:"id",type:"bytes32"}],outputs:[{name:"market",type:"tuple",components:[
  {name:"totalSupplyAssets",type:"uint128"},{name:"totalSupplyShares",type:"uint128"},
  {name:"totalBorrowAssets",type:"uint128"},{name:"totalBorrowShares",type:"uint128"},
  {name:"lastUpdate",type:"uint128"},{name:"fee",type:"uint128"}]}]},
 {type:"function",name:"position",stateMutability:"view",inputs:[{name:"id",type:"bytes32"},{name:"user",type:"address"}],outputs:[{name:"position",type:"tuple",components:[
  {name:"supplyShares",type:"uint256"},{name:"borrowShares",type:"uint128"},{name:"collateral",type:"uint128"}]}]}
] as const;
const IRM_ABI = [{type:"function",name:"borrowRateView",stateMutability:"view",inputs:[
 {name:"marketParams",type:"tuple",components:PARAMS},
 {name:"market",type:"tuple",components:[
  {name:"totalSupplyAssets",type:"uint128"},{name:"totalSupplyShares",type:"uint128"},
  {name:"totalBorrowAssets",type:"uint128"},{name:"totalBorrowShares",type:"uint128"},
  {name:"lastUpdate",type:"uint128"},{name:"fee",type:"uint128"}]}],
 outputs:[{name:"rate",type:"uint256"}]}] as const;
const ORACLE_ABI = [{type:"function",name:"price",stateMutability:"view",inputs:[],outputs:[{name:"price",type:"uint256"}]}] as const;

const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms));
async function json(url:string, init?:RequestInit, tries=5):Promise<any> {
 for(let i=0;i<tries;i++){
  try{
   if(url.startsWith(API)){const now=Date.now(),wait=Math.max(0,morphoNextRequestAt-now);morphoNextRequestAt=Math.max(now,morphoNextRequestAt)+125;if(wait)await sleep(wait);}
   const r=await fetch(url,{...init,signal:AbortSignal.timeout(30000)});
   if(r.ok)return await r.json();
   if(![429,500,502,503,504].includes(r.status)||i===tries-1)throw new Error("HTTP "+r.status+" "+url+" "+(await r.text()).slice(0,300));
   const ra=r.headers.get("retry-after"); await sleep(ra&&/^\d+$/.test(ra)?Math.min(Number(ra)*1000,600000):Math.min(1000*2**i,30000));
  }catch(e){if(i===tries-1||(String(e).includes("HTTP ")&&!/HTTP (429|500|502|503|504)/.test(String(e))))throw e;await sleep(Math.min(1000*2**i,30000));}
 }
 throw new Error("Retry exhaustion "+url);
}
async function limit<T,R>(xs:T[],n:number,fn:(x:T)=>Promise<R>):Promise<R[]>{
 const out=new Array<R>(xs.length);let k=0;
 await Promise.all(Array.from({length:Math.min(n,xs.length)},async()=>{while(true){const i=k++;if(i>=xs.length)return;out[i]=await fn(xs[i]);}}));return out;
}
function bi(x:any,label:string):bigint{if(typeof x==="bigint")return x;if(typeof x==="string"&&/^\d+$/.test(x))return BigInt(x);throw new Error("Invalid "+label);}
function down(x:bigint,y:bigint,d:bigint){return x*y/d;}
function up(x:bigint,y:bigint,d:bigint){return (x*y+d-1n)/d;}
function wm(x:bigint,y:bigint){return down(x,y,WAD);}
function taylor(r:bigint,s:bigint){const a=r*s,b=down(a,a,2n*WAD),c=down(b,a,3n*WAD);return a+b+c;}
function assetsUp(sh:bigint,assets:bigint,shares:bigint){return up(sh,assets+VA,shares+VS);}
const paramsHash=(p:any)=>keccak256(encodeAbiParameters([{type:"tuple",components:PARAMS}],[p]));
function normalizeMarket(x:any,chainId:number):any {
 const p={loanToken:getAddress(x.loan_token),collateralToken:getAddress(x.collateral_token),oracle:getAddress(x.oracle_address),irm:getAddress(x.irm_address),lltv:bi(x.lltv_wad,"lltv")};
 const id=String(x.market_id).toLowerCase();
 if(!/^0x[0-9a-f]{64}$/.test(id))throw new Error("Invalid market id");
 return {...x,chain_id:chainId,market_id:id,loan_token:p.loanToken,collateral_token:p.collateralToken,oracle_address:p.oracle,irm_address:p.irm,lltv_wad:p.lltv.toString(),params_hash_matches_market_id:paramsHash(p).toLowerCase()===id,params:p};
}
const query = [
"query MarketPositions($chainIds: [Int!]!, $first: Int!, $skip: Int!) {",
" marketPositions(where: { chainId_in: $chainIds }, orderBy: HealthFactor, orderDirection: Asc, first: $first, skip: $skip) {",
"  pageInfo { count countTotal } items { healthFactor market { marketId } user { address } }",
" }","}"
].join("\n");

async function marketsFor(chainId:number):Promise<any[]>{
 let cursor:string|null=null;const all=new Map<string,any>();
 for(let i=0;i<MAX_PAGES;i++){
  const q=new URLSearchParams({chain_id:String(chainId),limit:String(PAGE)});
  if(cursor)q.set("cursor",cursor);
  const res=await json(API+"/v1/blue/markets?"+q);
  if(!Array.isArray(res.data))throw new Error("Morpho markets response missing data");
  for(const x of res.data){
   if(Number(x.chain_id)!==chainId)throw new Error("Market response chain mismatch");
   const parsed=normalizeMarket(x,chainId);all.set(parsed.market_id,parsed);
  }
  cursor=typeof res.cursor==="string"&&res.cursor?res.cursor:null;
  if(!cursor)return [...all.values()].sort((a,b)=>a.market_id.localeCompare(b.market_id));
 }
 throw new Error("Market pagination safety limit; partial catalogue rejected");
}
async function allPositions(chainId:number):Promise<{rows:any[],pages:number,raw:number,total:number|null}>{
 let skip=0,raw=0,total:number|null=null;const all=new Map<string,any>();
 for(let page=0;page<MAX_PAGES;page++){
  const res=await json(API+"/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query,variables:{chainIds:[chainId],first:PAGE,skip}})});
  if(res.errors?.length)throw new Error("Morpho GraphQL: "+JSON.stringify(res.errors.slice(0,2)));
  const d=res.data?.marketPositions;if(!Array.isArray(d?.items))throw new Error("GraphQL items missing");
  if(typeof d.pageInfo?.count==="number"&&d.pageInfo.count!==d.items.length)throw new Error("GraphQL page count mismatch");
  if(typeof d.pageInfo?.countTotal==="number")total=d.pageInfo.countTotal;
  raw+=d.items.length;
  for(const x of d.items){
   const id=String(x.market?.marketId??"").toLowerCase(),user=x.user?.address;
   if(!/^0x[0-9a-f]{64}$/.test(id)||typeof user!=="string")continue;
   const borrower=getAddress(user),hf=x.healthFactor==null?null:Number(x.healthFactor);
   all.set(id+":"+borrower.toLowerCase(),{market_id:id,borrower,health_factor:Number.isFinite(hf)?hf:null});
  }
  skip+=d.items.length;
  if(!d.items.length||d.items.length<PAGE||(total!==null&&skip>=total))return{rows:[...all.values()],pages:page+1,raw,total};
 }
 throw new Error("Position pagination safety limit; partial inventory rejected");
}
async function rpcFor(chainId:number,provided?:string){
 if(provided)return{url:provided,source:"workflow_input"};
 const chains=await json("https://chainid.network/chains.json");
 const c=chains.find((x:any)=>Number(x.chainId)===chainId);
 const urls=(c?.rpc??[]).map((x:any)=>typeof x==="string"?x:x?.url).filter((x:any)=>typeof x==="string"&&x.startsWith("https://")&&!/[{}]/.test(x)&&!/apikey|api-key|your[_-]?key|infura|alchemy/i.test(x));
 for(const url of urls.slice(0,8)){
  try{const r=await json(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]})},1);if(Number(BigInt(r.result))===chainId)return{url,source:"chainid.network_public_rpc"};}catch{}
 }
 throw new Error("No chain-id-verified public RPC; provide rpc_url for chain "+chainId);
}
function sameParams(a:any,b:any){return String(a.loanToken).toLowerCase()===b.loanToken.toLowerCase()&&String(a.collateralToken).toLowerCase()===b.collateralToken.toLowerCase()&&String(a.oracle).toLowerCase()===b.oracle.toLowerCase()&&String(a.irm).toLowerCase()===b.irm.toLowerCase()&&BigInt(a.lltv)===b.lltv;}
async function tokenMetadata(chainId:number,ms:any[],previous:any){
 const cache={...(previous?.token_metadata??{})};
 const missing=[...new Set(ms.flatMap(m=>[m.loan_token,m.collateral_token]).map(x=>String(x).toLowerCase()))].filter(a=>!cache[a]||cache[a].metadata_status==="unavailable");
 const fetched=await limit(missing,8,async a=>{try{const x=await json(API+"/v0/tokens/"+chainId+":"+a);return{a,data:x.data??x};}catch(e){return{a,data:{metadata_status:"unavailable",error:String(e)}};}});
 for(const x of fetched)cache[x.a]=x.data;return cache;
}
async function main(){
 const chainId=Number(process.env.CHAIN_ID),days=Number(process.env.FORWARD_HORIZON_DAYS??"30");
 const force=process.env.FORCE_MARKET_REFRESH==="true",runId=process.env.GITHUB_RUN_ID??String(Date.now());
 if(!Number.isSafeInteger(chainId)||chainId<=0||!Number.isSafeInteger(days)||days<1||days>365)throw new Error("Invalid chain or horizon");
 const fs=await import("node:fs/promises"),path=await import("node:path"),root="data/market-discovery/"+chainId;
 await fs.mkdir(root,{recursive:true});let previous:any=null;
 try{previous=JSON.parse(await fs.readFile(path.join(root,"latest.json"),"utf8"));}catch{}
 const started=new Date(),cachedAt=previous?.coverage?.market_catalogue_fetched_at;
 const fresh=!force&&Array.isArray(previous?.markets)&&cachedAt&&started.getTime()-Date.parse(cachedAt)<CACHE_HOURS*3600000;
 let markets:any[],marketStatus="refreshed",marketError:string|null=null,marketFetchedAt=cachedAt??null,reused=false;
 if(fresh){markets=previous.markets.map((m:any)=>normalizeMarket(m,chainId));marketStatus="reused_cached_catalogue";reused=true;}
 else{try{markets=await marketsFor(chainId);marketFetchedAt=new Date().toISOString();}catch(e){marketError=String(e);if(Array.isArray(previous?.markets)){markets=previous.markets.map((m:any)=>normalizeMarket(m,chainId));marketStatus="stale_cache_after_refresh_failure";reused=true;}else{markets=[];marketStatus="failed_no_catalogue";}}}
 const chainName=(ChainUtils as any).CHAIN_METADATA?.[chainId]?.name??("Chain "+chainId);
 const morpho=getAddress(getChainAddress(chainId,"blue")),rpc=await rpcFor(chainId,process.env.RPC_URL);
 const chain=defineChain({id:chainId,name:chainName,nativeCurrency:{name:"Native",symbol:"NATIVE",decimals:18},rpcUrls:{default:{http:[rpc.url]}},contracts:{multicall3:{address:MULTICALL3}}});
 const client=createPublicClient({chain,transport:http(rpc.url,{timeout:30000,retryCount:2})});
 if(await client.getChainId()!==chainId)throw new Error("RPC chain id mismatch");
 const morphoCode=await client.getBytecode({address:morpho});if(!morphoCode||morphoCode==="0x")throw new Error("Morpho singleton has no code");
 const block=await client.getBlock({blockTag:"latest"}),now=block.timestamp,horizon=BigInt(days)*86400n;
 const prior=new Map((previous?.markets??[]).filter((m:any)=>["verified","verified_cached_immutable_params"].includes(m.onchain_verification_status)).map((m:any)=>[m.market_id,m]));
 for(const m of markets){if(prior.has(m.market_id)&&m.params_hash_matches_market_id){m.onchain_verification_status="verified_cached_immutable_params";m.onchain_verification_block=prior.get(m.market_id).onchain_verification_block??null;}}
 const verify=markets.filter(m=>m.onchain_verification_status!=="verified_cached_immutable_params");
 const multicallCode=await client.getBytecode({address:MULTICALL3});
 let verifiedResults:any[]=[];
 if(verify.length&&multicallCode&&multicallCode!=="0x"){
  try{verifiedResults=await client.multicall({allowFailure:true,batchSize:250,contracts:verify.map(m=>({address:morpho,abi:MORPHO_ABI,functionName:"idToMarketParams" as const,args:[m.market_id as Hex] as const}))});}
  catch{verifiedResults=[];}
 }
 if(verifiedResults.length!==verify.length){
  verifiedResults=await limit(verify,8,async m=>{try{return{status:"success",result:await client.readContract({address:morpho,abi:MORPHO_ABI,functionName:"idToMarketParams",args:[m.market_id as Hex]})};}catch{return{status:"failure"};}});
 }
 verify.forEach((m,i)=>{const r=verifiedResults[i];if(!m.params_hash_matches_market_id)m.onchain_verification_status="failed_market_id_hash_mismatch";else if(r?.status!=="success")m.onchain_verification_status="unavailable_onchain_read";else if(!sameParams(r.result,m.params))m.onchain_verification_status="failed_onchain_params_mismatch";else{m.onchain_verification_status="verified";m.onchain_verification_block=Number(block.number);}});
 let index:{rows:any[],pages:number,raw:number,total:number|null}={rows:[],pages:0,raw:0,total:null};
 let positionIndexStatus="complete",positionIndexError:string|null=null;
 try{index=await allPositions(chainId);}catch(e){
  positionIndexError=String(e);
  if(Array.isArray(previous?.position_index_records)){
   index={rows:previous.position_index_records,pages:previous?.coverage?.position_index_pages??0,raw:previous?.coverage?.position_index_raw_rows??previous.position_index_records.length,total:previous?.coverage?.position_index_reported_total??null};
   positionIndexStatus="failed_using_previous_snapshot";
  }else positionIndexStatus="failed_no_position_inventory";
 }
 if(positionIndexStatus==="complete"){
  if(index.total===null)positionIndexStatus="completed_total_unavailable";
  else if(index.rows.length!==index.total)positionIndexStatus="possible_offset_pagination_gap";
 }
 const byId=new Map(markets.map(m=>[m.market_id,m])),marketIds=[...new Set(index.rows.map(r=>r.market_id))];
 const contexts=new Map<string,any>();
 const contextRows=await limit(marketIds,8,async id=>{
  const m=byId.get(id);if(!m||!["verified","verified_cached_immutable_params"].includes(m.onchain_verification_status))return{id,error:"Market not verified"};
  try{
   const p=m.params,s=await client.readContract({address:morpho,abi:MORPHO_ABI,functionName:"market",args:[id as Hex]}) as any;
   if(s.lastUpdate===0n)throw new Error("Market not created");
   const price=await client.readContract({address:p.oracle,abi:ORACLE_ABI,functionName:"price"}) as bigint;
   let rate=0n;
   if(p.irm.toLowerCase()!=="0x0000000000000000000000000000000000000000"&&s.totalBorrowAssets>0n)rate=await client.readContract({address:p.irm,abi:IRM_ABI,functionName:"borrowRateView",args:[p,s]}) as bigint;
   const elapsed=now>s.lastUpdate?now-s.lastUpdate:0n;
   const interest=s.totalBorrowAssets>0n&&elapsed>0n?wm(s.totalBorrowAssets,taylor(rate,elapsed)):0n;
   const accrued=s.totalBorrowAssets+interest;
   const projectedMarket={...s,totalSupplyAssets:s.totalSupplyAssets+interest,totalBorrowAssets:accrued,lastUpdate:now};
   let futureRate=rate;
   if(p.irm.toLowerCase()!=="0x0000000000000000000000000000000000000000"&&accrued>0n)futureRate=await client.readContract({address:p.irm,abi:IRM_ABI,functionName:"borrowRateView",args:[p,projectedMarket]}) as bigint;
   const future=accrued+(accrued>0n?wm(accrued,taylor(futureRate,horizon)):0n);
   return{id,ctx:{state:s,price,rate,futureRate,accrued,future,growth:accrued>0n?Number(future)/Number(accrued):1,p,block:Number(block.number)}};
  }catch(e){return{id,error:String(e)};}
 });
 for(const x of contextRows)if(x.ctx)contexts.set(x.id,x.ctx);
 const positionChunks:any[][]=[];
 for(let i=0;i<index.rows.length;i+=250)positionChunks.push(index.rows.slice(i,i+250));
 const positionChunkResults=await limit(positionChunks,2,async chunk=>{
  if(multicallCode&&multicallCode!=="0x"){
   try{return await client.multicall({allowFailure:true,batchSize:40000,contracts:chunk.map(r=>({address:morpho,abi:MORPHO_ABI,functionName:"position" as const,args:[r.market_id as Hex,r.borrower as Address] as const}))});}
   catch{}
  }
  return await limit(chunk,10,async r=>{try{return{status:"success",result:await client.readContract({address:morpho,abi:MORPHO_ABI,functionName:"position",args:[r.market_id as Hex,r.borrower as Address]})};}catch{return{status:"failure"};}});
 });
 const positionStates=new Map<string,any>();
 positionChunks.forEach((chunk,ci)=>chunk.forEach((r,ri)=>{const result=positionChunkResults[ci]?.[ri];if(result?.status==="success")positionStates.set(r.market_id+":"+r.borrower.toLowerCase(),result.result);}));
 const evaluated=await limit(index.rows,12,async r=>{
  const c=contexts.get(r.market_id),m=byId.get(r.market_id),p=positionStates.get(r.market_id+":"+r.borrower.toLowerCase());
  if(!c||!m||!p)return{market_id:r.market_id,borrower:r.borrower,indexed_health_factor:r.health_factor,classification:"unknown_insufficient_data",onchain_verified:false,reason:!c||!m?"Market params or onchain risk context unavailable":"Onchain position read unavailable"};
  try{
   const calc=(assets:bigint)=>{if(p.borrowShares===0n)return{healthy:true,debt:0n,max:0n,hf:null};const debt=assetsUp(p.borrowShares,assets,c.state.totalBorrowShares),max=wm(down(p.collateral,c.price,PRICE_SCALE),c.p.lltv);return{healthy:max>=debt,debt,max,hf:debt>0n?Number(max)/Number(debt):null};};
   const cur=calc(c.accrued),future=calc(c.future);let cls="not_currently_liquidatable",seconds:number|null=null;
   if(p.borrowShares>0n&&!cur.healthy)cls="currently_liquidatable";
   else if(p.borrowShares>0n&&!future.healthy){cls="forecast_liquidatable_within_horizon";let lo=1n,hi=horizon;while(lo<hi){const mid=(lo+hi)/2n,assets=c.accrued+wm(c.accrued,taylor(c.futureRate,mid));if(calc(assets).healthy)lo=mid+1n;else hi=mid;}seconds=Number(lo);}
   return{market_id:r.market_id,borrower:r.borrower,indexed_health_factor:r.health_factor,collateral_assets_raw:p.collateral.toString(),borrow_shares_raw:p.borrowShares.toString(),current_debt_assets_raw:cur.debt.toString(),current_max_borrow_assets_raw:cur.max.toString(),current_health_factor:cur.hf,projected_debt_assets_raw:future.debt.toString(),projected_health_factor:future.hf,current_oracle_price_raw:c.price.toString(),oracle_address:m.oracle_address,lltv_wad:m.lltv_wad,borrow_rate_per_second_wad:c.futureRate.toString(),seconds_to_liquidatable:seconds,classification:cls,onchain_verified:true,verification_block:c.block,projection:{horizon_seconds:horizon.toString(),oracle_price_assumption:"constant_current_oracle_price",rate_assumption:"constant_current_borrow_rate",math:"Morpho wTaylorCompounded; borrow share assets round up; collateral capacity rounds down"}};
  }catch(e){return{market_id:r.market_id,borrower:r.borrower,indexed_health_factor:r.health_factor,classification:"unknown_insufficient_data",onchain_verified:false,reason:String(e)};}
 });
 const token=await tokenMetadata(chainId,markets,previous);
 const counts={currently:evaluated.filter(x=>x.classification==="currently_liquidatable").length,forecast:evaluated.filter(x=>x.classification==="forecast_liquidatable_within_horizon").length,unknown:evaluated.filter(x=>x.classification==="unknown_insufficient_data").length};
 const report={schema_version:"2.0.0",document_version:"v12",workflow:"market_discovery",chain:{chain_id:chainId,name:chainName},run_timestamp:new Date().toISOString(),configuration:{forward_horizon_days:days,market_catalogue_cache_hours:CACHE_HOURS,position_inventory_scope:"all rows returned by Morpho marketPositions for this chain",onchain_position_evaluation:"all indexed rows, multicall batches of 250 with individual-call fallback"},deployment:{morpho_blue:morpho,rpc_source:rpc.source,block_number:Number(block.number),block_hash:block.hash,block_timestamp:Number(now)},coverage:{market_catalogue_status:marketStatus,market_catalogue_fetched_at:marketFetchedAt,market_catalogue_reused:reused,market_catalogue_refresh_error:marketError,market_count:markets.length,market_params_verified:markets.filter(m=>["verified","verified_cached_immutable_params"].includes(m.onchain_verification_status)).length,market_params_unverified:markets.filter(m=>!["verified","verified_cached_immutable_params"].includes(m.onchain_verification_status)).length,position_index_status:positionIndexStatus,position_index_error:positionIndexError,position_pagination_complete:positionIndexStatus==="complete"&&index.total!==null&&index.rows.length===index.total,position_pagination_unique_vs_total:index.total===null?"source_total_unavailable":(index.rows.length+"/"+index.total),position_index_pages:index.pages,position_index_raw_rows:index.raw,position_index_reported_total:index.total,position_index_unique_rows:index.rows.length,positions_onchain_evaluated:evaluated.filter(x=>x.onchain_verified).length,not_currently_liquidatable:evaluated.filter(x=>x.classification==="not_currently_liquidatable").length,currently_liquidatable:counts.currently,forecast_liquidatable:counts.forecast,unknown_candidates:counts.unknown,risk_universe_completeness:"bounded_by_Morpho_GraphQL_inventory_and_unreported_indexer_lag"},markets:markets.map(({params,...m})=>m),token_metadata:token,position_index_records:index.rows,position_assessments:evaluated,risk_candidates:evaluated.filter(x=>x.classification!=="not_currently_liquidatable"),risk_contexts:[...contexts.entries()].map(([market_id,c])=>({market_id,market_state:{total_supply_assets:c.state.totalSupplyAssets.toString(),total_supply_shares:c.state.totalSupplyShares.toString(),total_borrow_assets:c.state.totalBorrowAssets.toString(),total_borrow_shares:c.state.totalBorrowShares.toString(),last_update:c.state.lastUpdate.toString(),fee:c.state.fee.toString()},oracle_price_raw:c.price.toString(),accrual_rate_per_second_wad:c.rate.toString(),forward_rate_per_second_wad:c.futureRate.toString(),elapsed_seconds:c.state.lastUpdate<now?(now-c.state.lastUpdate).toString():"0",accrued_total_borrow_assets:c.accrued.toString(),projected_total_borrow_assets:c.future.toString(),growth_factor:c.growth,block_number:c.block})),risk_candidates:evaluated,sources:[{name:"Morpho REST API",endpoint:"/v1/blue/markets",role:"market catalogue"},{name:"Morpho GraphQL API",endpoint:"/graphql",role:"chain-scoped indexed position inventory"},{name:"Morpho Blue singleton",address:morpho,role:"onchain market and position verification"},{name:"Morpho IRM borrowRateView",role:"current rate and constant-rate projection"}],previous_document:previous?"latest.json":null};
 const lines=["# Morpho Blue Market Discovery — "+chainName+" ("+chainId+")","","- **Document version:** v12","- **Run timestamp:** "+report.run_timestamp,"- **Forward horizon:** "+days+" days","- **Morpho Blue:** "+morpho,"- **Markets:** "+markets.length,"- **Indexed positions:** "+index.rows.length,"- **Onchain evaluated positions:** "+report.coverage.positions_onchain_evaluated,"- **Currently liquidatable:** "+counts.currently,"- **Forecast liquidatable:** "+counts.forecast,"- **Unknown:** "+counts.unknown,"","## Coverage","","- Market catalogue: "+marketStatus+"; last fetched "+(marketFetchedAt??"unknown"),"- Onchain market params verified: "+report.coverage.market_params_verified+"/"+markets.length,"- GraphQL index status: "+positionIndexStatus+"; pages: "+index.pages+"; rows "+index.raw+"; reported total "+(index.total??"unknown"),"- RPC source: "+rpc.source+"; block "+block.number,"","## Market catalogue","","| Market ID | Loan token | Collateral token | Oracle | IRM | LLTV | Created block | Created timestamp | Params verification |","|---|---|---|---|---|---:|---:|---:|---|"]; 
 for(const m of markets){const loan=token[String(m.loan_token).toLowerCase()]??{},coll=token[String(m.collateral_token).toLowerCase()]??{};lines.push("| "+m.market_id+" | "+(loan.symbol??m.loan_token)+" ("+m.loan_token+") | "+(coll.symbol??m.collateral_token)+" ("+m.collateral_token+") | "+m.oracle_address+" | "+m.irm_address+" | "+m.lltv_wad+" | "+(m.creation_block_number??"unknown")+" | "+(m.creation_timestamp??"unknown")+" | "+m.onchain_verification_status+" |");}
 lines.push("","## Token metadata","","| Token address | Name | Symbol | Decimals | Metadata status |","|---|---|---|---:|---|");
 for(const [address,t] of Object.entries(token) as any[])lines.push("| "+address+" | "+(t.name??"unknown")+" | "+(t.symbol??"unknown")+" | "+(t.decimals??"unknown")+" | "+(t.metadata_status??"available")+" |");
 lines.push("","## Onchain market risk contexts","","| Market ID | Supply assets | Supply shares | Borrow assets | Borrow shares | Last update | Fee | Oracle price | Accrual rate | Forward rate | Accrued debt | Projected debt | Growth |","|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
 for(const [id,c] of contexts.entries())lines.push("| "+id+" | "+c.state.totalSupplyAssets.toString()+" | "+c.state.totalSupplyShares.toString()+" | "+c.state.totalBorrowAssets.toString()+" | "+c.state.totalBorrowShares.toString()+" | "+c.state.lastUpdate.toString()+" | "+c.state.fee.toString()+" | "+c.price.toString()+" | "+c.rate.toString()+" | "+c.futureRate.toString()+" | "+c.accrued.toString()+" | "+c.future.toString()+" | "+c.growth+" |");
 lines.push("","## Onchain market risk contexts","","| Market ID | Oracle price (raw) | Accrual rate (WAD/sec) | Forward rate (WAD/sec) | Accrued borrow assets | Projected borrow assets | Growth factor |","|---|---:|---:|---:|---:|---:|---:|");
 for(const [id,c] of contexts.entries())lines.push("| "+id+" | "+c.price.toString()+" | "+c.rate.toString()+" | "+c.futureRate.toString()+" | "+c.accrued.toString()+" | "+c.future.toString()+" | "+c.growth+" |");
 lines.push("","## Risk candidates","","| Market | Borrower | Indexed HF | Collateral raw | Borrow shares raw | Current debt raw | Current max borrow raw | Current HF | Projected debt raw | Projected HF | Classification | Seconds |","|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|");
 const riskCandidates=evaluated.filter(x=>x.classification!=="not_currently_liquidatable");
 for(const x of riskCandidates)lines.push("| "+x.market_id+" | "+x.borrower+" | "+(x.indexed_health_factor??"unknown")+" | "+(x.collateral_assets_raw??"unknown")+" | "+(x.borrow_shares_raw??"unknown")+" | "+(x.current_debt_assets_raw??"unknown")+" | "+(x.current_max_borrow_assets_raw??"unknown")+" | "+(x.current_health_factor??"unknown")+" | "+(x.projected_debt_assets_raw??"unknown")+" | "+(x.projected_health_factor??"unknown")+" | "+x.classification+" | "+(x.seconds_to_liquidatable??"—")+" |");
 lines.push("","## Full indexed position inventory","","| Market ID | Borrower | Morpho indexed HF | Onchain current HF | Projected HF | Classification |","|---|---|---:|---:|---:|---|");
 const assessmentByKey=new Map(evaluated.map(x=>[x.market_id+":"+x.borrower.toLowerCase(),x]));
 for(const x of index.rows){const a=assessmentByKey.get(x.market_id+":"+x.borrower.toLowerCase());lines.push("| "+x.market_id+" | "+x.borrower+" | "+(x.health_factor??"unknown")+" | "+(a?.current_health_factor??"unknown")+" | "+(a?.projected_health_factor??"unknown")+" | "+(a?.classification??"not_evaluated")+" |");}
 lines.push("","## Method and limitations","","- The JSON document retains the complete Morpho GraphQL position inventory returned for this chain.","- Market ids are checked against keccak256(abi.encode(MarketParams)); immutable market parameters are verified against Morpho idToMarketParams.","- Candidate positions are read from the Morpho singleton at the recorded block. Eligibility uses Morpho's rounding rules: borrow assets round up; collateral value and LLTV capacity round down.","- Accrued interest uses Morpho's wTaylorCompounded formula and the IRM borrowRateView.","- The forward scenario assumes constant current borrow rate and constant current oracle price. Future rate changes, market activity, and oracle movements can change outcomes.","- Every position returned by the Morpho GraphQL inventory is individually read from the Morpho singleton, using Multicall3 batches of 250 where available and bounded direct-call fallback otherwise. The source does not expose indexer lag; completeness is therefore bounded by the indexer inventory and freshness.","- Read-only only; no transactions or contract deployments.","");
 const md=lines.join("\n"),stamp=started.toISOString().replace(/[-:.]/g,"")+"-run-"+runId,snap=path.join(root,"snapshots");
 await fs.mkdir(snap,{recursive:true});
 await fs.writeFile(path.join(root,"latest.json"),JSON.stringify(report,null,2)+"\n","utf8");
 await fs.writeFile(path.join(root,"latest.md"),md,"utf8");
 await fs.writeFile(path.join(snap,stamp+".json"),JSON.stringify(report,null,2)+"\n","utf8");
 await fs.writeFile(path.join(snap,stamp+".md"),md,"utf8");
 console.log(JSON.stringify({chain_id:chainId,markets:markets.length,indexed_positions:index.rows.length,evaluated_positions:evaluated.length,...counts,latest_json:path.join(root,"latest.json"),latest_markdown:path.join(root,"latest.md"),snapshot:path.join(snap,stamp)},null,2));
}
main().catch(e=>{console.error(e?.stack??String(e));process.exitCode=1;});
