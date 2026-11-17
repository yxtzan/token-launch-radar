// The token radar's model: one sealed DefiLlama snapshot in, one ranked board out.
//
// Every pre-token protocol in the snapshot (no CoinGecko id and no symbol: no token exists yet)
// is ranked by an implied value built only from the snapshot's own figures:
//
//   peers      tokenized protocols (market cap recorded, TVL > 0) give market-cap / TVL ratios.
//              Every ratio is first winsorized at the global 95th percentile of all ratios, so
//              one thin-TVL outlier cannot drag a whole category's multiple up with it. A
//              category's multiple is then its median (winsorized) ratio shrunk toward the
//              global median with four phantom peers:
//              (n * categoryMedian + 4 * globalMedian) / (n + 4), so a thin category borrows
//              the market's centre instead of trusting two data points.
//   momentum   1 + clamp(change_7d, -30, 50) / 200      (no change reported: 1)
//   maturity   0.88 + 0.24 * min(age_days / 1095, 1)     (no listing date: 1)
//   scope      1 + 0.02 * min(chains - 1, 6)
//   implied    round(tvl_usd * multiple * momentum * maturity * scope)
//
// Rows sort by implied value, then TVL, then slug; values are then walked in rank order and
// forced strictly decreasing (previous - 1, never below 1) so the ranking never ties. Tokenized
// protocols never appear on the board: they already have a market value of their own.
//
// Deterministic: no clock, no randomness, no locale formatting. Ages are always vs as_of.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One ranked row: the board's row and, with its factors rounded, the dashboard's row. */
interface RadarRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  multiple: number;
  peers: number;
  momentum: number;
  maturity: number;
  scope: number;
  implied_value_usd: number;
  rank: number;
  signals: string[];
  farm_steps: string[];
}

/** Everything data.js carries: provenance, the model's own summary of itself, and the rows. */
interface RadarData {
  as_of: string;
  floor_usd: number;
  stats: { protocols: number; pre_token: number; watchlist: number; tokenized: number; total_implied_usd: number };
  method: {
    summary: string;
    global_median: number;
    winsor_cap: number;
    categories: Record<string, { peers: number; multiple: number }>;
  };
  rows: RadarRow[];
}

const DAY_MS = 86_400_000;
const SHRINK_PEERS = 4;
const MATURITY_SPAN_DAYS = 1095;

/** A whole day count from listed_at to as_of, clamped at zero; null when there is no usable date. */
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Whether a protocol records no token at all. */
function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

interface CategoryPeers {
  peers: number;
  multiple: number;
}

/** Peer multiples from the tokenized protocols: ratios winsorized at the global 95th percentile,
 *  then per-category medians shrunk toward the global one. */
function peerMultiples(protocols: SnapshotProtocol[]): { globalMedian: number; winsorCap: number; byCategory: Map<string, CategoryPeers> } {
  const raw: { category: string | null; ratio: number }[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    raw.push({ category: p.category, ratio: p.mcap_usd / p.tvl_usd });
  }
  // The winsorizing cap: the 95th percentile of every peer ratio, read off the sorted list.
  const sorted = raw.map((r) => r.ratio).sort((a, b) => a - b);
  const winsorCap = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]! : 0;
  const all: number[] = [];
  const grouped = new Map<string, number[]>();
  for (const { category, ratio } of raw) {
    const winsorized = Math.min(ratio, winsorCap);
    all.push(winsorized);
    if (category !== null) {
      const arr = grouped.get(category) ?? [];
      arr.push(winsorized);
      grouped.set(category, arr);
    }
  }
  const globalMedian = all.length > 0 ? median(all) : 1;
  const byCategory = new Map<string, CategoryPeers>();
  for (const [category, ratios] of grouped) {
    const n = ratios.length;
    byCategory.set(category, { peers: n, multiple: (n * median(ratios) + SHRINK_PEERS * globalMedian) / (n + SHRINK_PEERS) });
  }
  return { globalMedian, winsorCap, byCategory };
}

/** The multiple and peer count one protocol is valued with. */
function multipleFor(p: SnapshotProtocol, peers: { globalMedian: number; byCategory: Map<string, CategoryPeers> }): { multiple: number; peers: number } {
  if (p.category === null) return { multiple: peers.globalMedian, peers: 0 };
  const group = peers.byCategory.get(p.category);
  if (group === undefined) return { multiple: peers.globalMedian, peers: 0 };
  return { multiple: group.multiple, peers: group.peers };
}

/** The 7-day TVL momentum factor: damped, clamped, neutral when unreported. */
function momentumOf(change7d: number | null): number {
  if (change7d === null) return 1;
  const clamped = Math.min(50, Math.max(-30, change7d));
  return 1 + clamped / 200;
}

/** The maturity factor: a protocol tracked for three years earns the full premium. */
function maturityOf(age: number | null): number {
  if (age === null) return 1;
  return 0.88 + 0.24 * Math.min(age / MATURITY_SPAN_DAYS, 1);
}

/** The scope factor: up to +12% for the broadest multi-chain footprints. */
function scopeOf(chains: string[]): number {
  return 1 + 0.02 * Math.min(Math.max(chains.length - 1, 0), 6);
}

/** A signed one-decimal percentage, e.g. +18.2 or -7.9 (toFixed is locale-independent). */
function pct(change: number): string {
  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}`;
}

/** 2-4 short signals per row, each read straight off the row's own figures. */
function signalsFor(p: SnapshotProtocol, age: number | null, onWatchlist: boolean, categoryLeader: boolean): string[] {
  const out: string[] = [];
  if (onWatchlist) out.push('Watchlist');
  if (p.change_7d !== null && Math.abs(p.change_7d) >= 5) out.push(`TVL ${pct(p.change_7d)}% in 7d`);
  if (age !== null && age >= 365) out.push(`Tokenless ${(age / 365).toFixed(1)} years`);
  if (p.chains.length >= 2) out.push(`On ${p.chains.length} chains`);
  if (categoryLeader) out.push('Category leader by TVL');
  if (out.length < 2 && p.change_7d === null) out.push('No 7d TVL change reported');
  if (out.length < 2 && age === null) out.push('Listing date unknown');
  if (out.length < 2) out.push('Pre-token, no token yet');
  if (out.length < 2) out.push(p.chains.length === 0 ? 'Chain footprint unreported' : p.chains.length === 1 ? 'Single-chain footprint' : 'Multi-chain footprint');
  return out.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Farm plans: one playbook per category family, five steps each, every step a
// concrete action on the protocol with a cost and a time. Snapshot-driven
// variations (momentum, multi-chain spread, long history) keep two protocols
// in one category from receiving identical plans.
// ---------------------------------------------------------------------------

type PlaybookKey =
  | 'dex' | 'lending' | 'derivatives' | 'stablecoin' | 'staking' | 'bridge' | 'yield'
  | 'allocator' | 'rwa' | 'exchange' | 'chain' | 'basis' | 'prediction' | 'insurance'
  | 'privacy' | 'governance' | 'generic';

const PLAYBOOK_BY_CATEGORY: Record<string, PlaybookKey> = {
  Dexs: 'dex',
  Lending: 'lending',
  'Uncollateralized Lending': 'lending',
  Derivatives: 'derivatives',
  'Interest Rate Derivatives': 'derivatives',
  'Options Vault': 'derivatives',
  CDP: 'stablecoin',
  'CDP Manager': 'stablecoin',
  'Dual-Token Stablecoin': 'stablecoin',
  'Stablecoin Wrapper': 'stablecoin',
  'Liquid Staking': 'staking',
  'Staking Pool': 'staking',
  'Liquid Restaking': 'staking',
  Restaking: 'staking',
  'Restaked BTC': 'staking',
  'Anchor BTC': 'staking',
  'Decentralized BTC': 'staking',
  Bridge: 'bridge',
  'Canonical Bridge': 'bridge',
  'Cross Chain Bridge': 'bridge',
  Yield: 'yield',
  'Yield Aggregator': 'yield',
  Farm: 'yield',
  'Leveraged Farming': 'yield',
  'Liquidity Manager': 'yield',
  'Risk Curators': 'allocator',
  'Onchain Capital Allocator': 'allocator',
  Indexes: 'allocator',
  'Collateral Markets': 'allocator',
  RWA: 'rwa',
  CEX: 'exchange',
  CeDeFi: 'exchange',
  'Crypto Card Issuer': 'exchange',
  Payments: 'exchange',
  'OTC Marketplace': 'exchange',
  Chain: 'chain',
  'Basis Trading': 'basis',
  'Prediction Market': 'prediction',
  Insurance: 'insurance',
  Privacy: 'privacy',
  'Governance Incentives': 'governance',
};

interface FarmCtx {
  name: string;
  chain: string;
  chainCount: number;
  stake: string;
  hold: number;
}

/** The interpolation context for one protocol's plan, its budget tier read off its own TVL. */
function farmCtx(p: SnapshotProtocol, age: number | null): FarmCtx {
  const stake = p.tvl_usd >= 500_000_000 ? '$1,000' : p.tvl_usd >= 50_000_000 ? '$250' : '$25';
  const hold = age === null ? 45 : age < 180 ? 60 : age < 365 ? 45 : 30;
  return {
    name: p.name,
    chain: p.chains.length > 0 ? p.chains[0]! : 'its main chain',
    chainCount: p.chains.length,
    stake,
    hold,
  };
}

const PLAYBOOKS: Record<PlaybookKey, (c: FarmCtx) => string[]> = {
  dex: (c) => [
    `Open ${c.name}'s app on ${c.chain} and make a first swap of about $50 between two liquid assets: one trade starts your activity history on the protocol; it costs gas only (about $0.10-2 on ${c.chain}) and takes 5 minutes.`,
    `Add ${c.stake} of liquidity to ${c.name}'s busiest pool on ${c.chain} and keep the LP position open: liquidity depth is what most DEX point programs measure; the position costs ${c.stake} of capital plus a few dollars of gas and takes 15 minutes to set up.`,
    `Route one swap a week through ${c.name} for the next month, even a $10 trade: repeated weekly activity counts for more than one large trade; each swap costs under $2 of gas and takes 5 minutes.`,
    `Hold the LP position for at least ${c.hold} days and claim any fees or rewards ${c.name} shows on its rewards page once a month; holding costs nothing beyond the capital already in, and each check takes 10 minutes.`,
    `Before withdrawing, note your ${c.name} position dates and amounts in a farm log: if a points season or snapshot is announced you will know exactly what you held; it costs nothing and takes 10 minutes.`,
  ],
  lending: (c) => [
    `Open ${c.name} on ${c.chain} and supply about $50 of USDC to its main lending market: a first deposit starts your history as a supplier; it costs gas only (about $0.10-2 on ${c.chain}) and takes 5 minutes.`,
    `Raise the supply to ${c.stake} and borrow a small amount, about 20% of what you supplied, against it: using both sides of ${c.name} is what lending activity scores usually count; it costs ${c.stake} of capital plus a few dollars of gas and takes 15 minutes.`,
    `Repay part of the borrow and borrow again once a week for a month, keeping your health factor comfortably above 1.5: the churn shows an active borrower, not a parked deposit; each adjustment costs under $2 of gas and takes 10 minutes.`,
    `Hold the supplied position for at least ${c.hold} days so it appears in more than one weekly snapshot of ${c.name}'s markets; the cost is the ${c.stake} staying supplied, and checking the position takes 5 minutes a week.`,
    `Check ${c.name}'s points or rewards page before you withdraw anything, and claim only from the link the protocol itself publishes; checking costs nothing, never pay a third party to claim, and it takes 10 minutes.`,
  ],
  derivatives: (c) => [
    `Deposit about $50 of USDC as margin on ${c.name} and open one very small position, long or short: a first trade starts your derivatives history; it costs the $50 margin plus under $2 of fees and takes 10 minutes.`,
    `Build the margin up to ${c.stake} and keep one hedged position open, sized so a 10% move cannot liquidate it: steady open interest is what derivatives programs usually reward; it costs ${c.stake} of margin and takes 15 minutes to set up.`,
    `Close and reopen a small trade once a week for a month on ${c.name}, varying the market you trade: regular volume across markets reads as a real user, not a one-off; each round trip costs a few dollars of fees and takes 10 minutes.`,
    `If ${c.name} offers a vault or options product beside its main market, place a small test amount there too and leave it for ${c.hold} days: a second product line diversifies how your activity is counted, and checking it takes 10 minutes.`,
    `Keep a simple log of every trade on ${c.name} with dates and sizes, and review open risk once a week; the log costs nothing, takes 5 minutes a week, and keeps a funding-rate surprise from wiping the position.`,
  ],
  stablecoin: (c) => [
    `Deposit about $50 of collateral into ${c.name} on ${c.chain} and mint a small amount of its stablecoin: minting is the core action the protocol exists for; it costs gas only (about $0.10-2 on ${c.chain}) and takes 10 minutes.`,
    `Scale the position to ${c.stake} of collateral and hold the minted stablecoin rather than selling it at once: balances held across snapshots are the simplest activity signal; the position costs ${c.stake} of capital and takes 15 minutes to set up.`,
    `Provide a small amount of the stablecoin to ${c.name}'s main liquidity pool or stability module, if it has one, and leave it for at least ${c.hold} days; it costs a few dollars of gas to enter and 10 minutes to check monthly.`,
    `Repay a slice of the minted amount and mint again once a month: gentle churn on ${c.name} shows an ongoing user while keeping the same collateral base; each cycle costs under $2 of gas and takes 10 minutes.`,
    `Watch ${c.name}'s peg and collateral health weekly and keep your own position well over-collateralised: a depeg is the main risk in this category, the check costs nothing and takes 5 minutes.`,
  ],
  staking: (c) => [
    `Stake about $50 worth of the base asset through ${c.name} on ${c.chain} and keep the receipt token it issues: staking is the protocol's core action; it costs gas only (about $0.10-2 on ${c.chain}) and takes 10 minutes.`,
    `Build the stake up to ${c.stake} and leave it untouched for at least ${c.hold} days: staking programs reward balances that stay, not balances that churn; the cost is the ${c.stake} locked in the position.`,
    `Use the receipt token in one other place ${c.name} points to, such as its own restaking product or a partner pool, with a small test amount first; it costs a few dollars of gas and takes 15 minutes.`,
    `Claim and restake any rewards ${c.name} distributes once a month so the position compounds; each claim costs under $2 of gas and takes 10 minutes.`,
    `Read ${c.name}'s points or loyalty page before unstaking anything, and note your stake dates in a farm log: checking costs nothing and takes 10 minutes, and unstaking queues can take days, so plan the exit early.`,
  ],
  bridge: (c) => [
    `Bridge about $50 of USDC to ${c.chain} through ${c.name} and use the arrived funds in one app on the destination chain: a completed trip is the activity that counts; it costs the bridge fee plus gas (about $1-5) and takes 15 minutes.`,
    `Bridge ${c.stake} through ${c.name} on a second route it supports, for example back toward ${c.chain} or onward to another chain, and keep the funds working there for at least ${c.hold} days; the cost is the fee on ${c.stake} and 15 minutes.`,
    `Repeat one small bridge a month through ${c.name}, alternating directions: monthly consistency across routes reads as a genuine user of the bridge; each trip costs about $1-5 and takes 15 minutes.`,
    `If ${c.name} runs volume milestones or a points program, check your progress on its own page after each trip and claim only from links it publishes; checking costs nothing and takes 10 minutes.`,
    `Log every ${c.name} transaction hash with dates and amounts in a farm log: bridge activity is the easiest to prove later and the hardest to reconstruct from memory, and the log costs nothing but 5 minutes per trip.`,
  ],
  yield: (c) => [
    `Deposit about $50 of USDC into ${c.name}'s main vault on ${c.chain}: a first deposit starts your history as a vault user; it costs gas only (about $0.10-2 on ${c.chain}) and takes 5 minutes.`,
    `Raise the deposit to ${c.stake} and keep the vault shares rather than withdrawing after the first harvest: time-weighted balances are what yield programs usually measure; the cost is ${c.stake} of capital and 15 minutes to set up.`,
    `Add a second, smaller position in another ${c.name} vault with a different strategy, about a quarter of the first: two vaults show broader use of the protocol; it costs a few dollars of gas and takes 15 minutes.`,
    `Leave both positions for at least ${c.hold} days and claim or compound any rewards monthly from ${c.name}'s own page; each claim costs under $2 of gas and takes 10 minutes.`,
    `Compare your vaults' returns on ${c.name} once a month and move only what is clearly idle: over-trading a yield position costs more in gas than it earns, and the review takes 15 minutes.`,
  ],
  allocator: (c) => [
    `Deposit about $50 of USDC into one of ${c.name}'s curated vaults on ${c.chain}: entering a curator's vault is the protocol's core action; it costs gas only (about $0.10-2 on ${c.chain}) and takes 10 minutes.`,
    `Build the position to ${c.stake}, split across two vaults with different curators or strategies if ${c.name} offers them: diversification across curators is the behaviour this category is built around; it costs ${c.stake} of capital and takes 20 minutes.`,
    `Hold the vault shares for at least ${c.hold} days and read the curator's monthly report or dashboard update when ${c.name} publishes one; holding costs nothing beyond the capital in, and the read takes 10 minutes.`,
    `Rebalance once a quarter at most: move a slice from the weakest vault to the strongest rather than exiting ${c.name} entirely; each rebalance costs a few dollars of gas and takes 15 minutes.`,
    `Check ${c.name}'s rewards or points page before withdrawing, and keep a log of which curator held your money and when; the check costs nothing and takes 10 minutes.`,
  ],
  rwa: (c) => [
    `Complete ${c.name}'s onboarding on ${c.chain}, including any identity check it requires for its real-world-asset products: access approval is the real first step in this category; it costs no capital and takes about 20 minutes.`,
    `Mint or buy about $50 of ${c.name}'s yield-bearing asset as a first test: a small completed purchase proves the flow works for your wallet; it costs the $50 plus a few dollars of gas and takes 15 minutes.`,
    `Build the holding to ${c.stake} and simply hold it: RWA yields accrue with time, and time-held balances are the activity that matters here; the cost is ${c.stake} of capital, checked in 5 minutes a month.`,
    `Hold for at least ${c.hold} days, then test a small redemption or secondary sale of about $25 to learn ${c.name}'s exit terms before you ever need them; the test costs the spread on $25 and takes 15 minutes.`,
    `Save ${c.name}'s offering documents and your transaction records with dates and amounts: RWA positions can carry lock-ups and paperwork, and the filing costs nothing and takes 10 minutes.`,
  ],
  exchange: (c) => [
    `Create an account on ${c.name}, finish its identity verification and turn on two-factor authentication: a verified account is the entry ticket for every later action; it costs no capital and takes about 20 minutes.`,
    `Make a first deposit of about $50 and one small spot trade on ${c.name}: a funded, trading account is what separates a user from a sign-up; the trade costs under $1 of fees and takes 10 minutes.`,
    `Build activity to ${c.stake} over the first month across a few trades rather than one, and try one more ${c.name} product, such as its earn, card or payments feature, with a small amount; it takes 15 minutes a week.`,
    `Keep a modest balance and at least one action a month on ${c.name} for ${c.hold} days or more: exchanges reward accounts that stay active across months, not one-week bursts; checking in costs nothing and takes 5 minutes.`,
    `Download your ${c.name} statements and keep a log of deposits, trades and withdrawals with dates: exchange records are your proof trail, and the download costs nothing and takes 10 minutes.`,
  ],
  chain: (c) => [
    `Bridge about $50 to ${c.name}'s chain (${c.chain}) and make a first swap on its best-known native DEX: a funded wallet with a real transaction is the base unit of chain activity; it costs about $1-5 of bridge and gas fees and takes 15 minutes.`,
    `Use two or three of ${c.name}'s native apps in the first week, a lending market, a DEX and one other, with about $25 in each: breadth across a chain's own apps is what ecosystem programs count; it costs a few dollars of gas and takes 30 minutes.`,
    `Keep ${c.stake} of total value working across ${c.name}'s apps and make at least one transaction a week for a month: consistency across weeks matters more than one busy day, and each week costs under $2 of gas and 10 minutes.`,
    `Hold a small balance of the chain's gas token and your app positions for at least ${c.hold} days; the cost is the capital staying on ${c.name}, and a weekly check takes 5 minutes.`,
    `Follow ${c.name}'s own ecosystem or points page and do any small quest it lists, from its official links only; quests cost a few dollars of gas each and take about 15 minutes apiece.`,
  ],
  basis: (c) => [
    `Deposit about $50 of USDC into ${c.name} on ${c.chain} and open its smallest basis or delta-neutral position: entering the trade is the protocol's core action; it costs gas only (about $0.10-2) and takes 15 minutes.`,
    `Scale the position to ${c.stake} once you have watched one funding cycle settle: basis returns come from funding payments over time, so the position needs weeks, not days; it costs ${c.stake} of capital and 10 minutes to check weekly.`,
    `Hold the position through at least ${c.hold} days of funding settlements and record the rate ${c.name} shows each week; the record costs nothing, takes 5 minutes a week, and tells you whether the trade still pays.`,
    `If funding turns negative for a full week, halve the position rather than closing it outright: sizing down keeps your ${c.name} history alive while cutting the bleed; the adjustment costs a few dollars and takes 10 minutes.`,
    `Check ${c.name}'s rewards page before fully exiting, and unwind in two steps a week apart so the exit itself looks like normal use; each step costs a few dollars of fees and takes 10 minutes.`,
  ],
  prediction: (c) => [
    `Fund an account on ${c.name} with about $50 and place one small position in a market you actually follow: a first settled trade is the activity that counts; it costs the $50 stake and takes 10 minutes.`,
    `Trade two or three different markets on ${c.name} over the first month, keeping each position at a share of ${c.stake} or smaller: breadth across markets reads as a real participant; each trade takes 10 minutes.`,
    `Let at least one position run to settlement rather than selling early, then re-enter a new market with part of the proceeds: settled history is the strongest signal on ${c.name}, and the cycle takes a month of calendar time.`,
    `If ${c.name} offers liquidity provision or a rewards program, add a small test amount and leave it for at least ${c.hold} days; it costs a few dollars of spread and takes 15 minutes to set up.`,
    `Keep a log of every market, position and settlement on ${c.name} with dates: prediction accounts are judged on history, and the log costs nothing but 5 minutes per trade.`,
  ],
  insurance: (c) => [
    `Buy about $50 of cover from ${c.name} on ${c.chain} for an asset or protocol you genuinely use: a real policy is the core action of this category; the premium costs a few dollars and the purchase takes 15 minutes.`,
    `Extend cover to ${c.stake} of value and keep the policy active for its full term, at least ${c.hold} days: continuous cover across terms is what insurers of this kind track; the cost is the premium on ${c.stake}.`,
    `If ${c.name} lets users stake into its risk pools, place a small test amount in one pool and leave it a full quarter: pool staking is the second side of the protocol, and it takes 15 minutes to set up.`,
    `Renew the policy once when it lapses rather than letting cover drop: a renewal shows an ongoing customer of ${c.name}, costs another small premium and takes 10 minutes.`,
    `Save the policy documents and check ${c.name}'s claims and rewards page before the term ends; the check costs nothing and takes 10 minutes.`,
  ],
  privacy: (c) => [
    `Make a first small deposit of about $25 into ${c.name}'s shielded pool on ${c.chain} and wait the full delay it recommends before touching the funds: privacy tools reward patience, and rushing breaks the point; it costs gas only and takes 10 minutes plus the wait.`,
    `Build up to ${c.stake} across a few deposits on different days rather than one lump: varied timing is both better privacy practice and steadier activity on ${c.name}; each deposit costs under $2 of gas and takes 10 minutes.`,
    `Make one shielded transfer inside ${c.name} to a second wallet you control, keeping amounts modest: an internal transfer exercises the protocol's main feature and takes 15 minutes.`,
    `Leave the balance shielded for at least ${c.hold} days and interact about once a month: long-lived shielded balances are the usage this category is built on, and a monthly check takes 5 minutes.`,
    `Withdraw a small test amount to a fresh address before you ever need the full sum, and keep your ${c.name} notes and keys backed up offline: losing the note loses the funds, and the backup costs nothing and takes 10 minutes.`,
  ],
  governance: (c) => [
    `Take part in one live incentive or governance action on ${c.name}, such as voting, staking into its incentive program or completing a published task: participation is the product here; it costs gas only (about $0.10-2 on ${c.chain}) and takes 15 minutes.`,
    `Commit ${c.stake} to ${c.name}'s main incentive pool or position and keep it there: committed capital across a full distribution round is what these programs measure; the cost is ${c.stake} of capital and 15 minutes to set up.`,
    `Join every distribution or voting round ${c.name} runs for the next quarter, even the small ones: a complete attendance record is the strongest signal in this category, and each round takes about 15 minutes.`,
    `Hold the position for at least ${c.hold} days and claim each distribution from ${c.name}'s own page as it lands; claims cost under $2 of gas each and take 10 minutes.`,
    `Keep a log of rounds, votes and distributions with dates: governance history is portable proof of participation, and the log costs nothing but 5 minutes a round.`,
  ],
  generic: (c) => [
    `Open ${c.name} on ${c.chain} and make its smallest useful first action, a deposit, stake or trade of about $25: any recorded first use starts your history with the protocol; it costs gas only (about $0.10-2 on ${c.chain}) and takes 10 minutes.`,
    `Build the position to ${c.stake} in ${c.name}'s main product and keep it open rather than testing and leaving in the same day; the cost is ${c.stake} of capital plus a few dollars of gas, and it takes 15 minutes to set up.`,
    `Try a second feature of ${c.name} with a small test amount, whatever sits beside the main product in its app: using two features reads as a real user, not a single-purpose farm; it takes about 15 minutes.`,
    `Hold the position for at least ${c.hold} days and do one small qualifying action a week, a deposit, a claim or a vote; each action costs under $2 of gas and takes 10 minutes.`,
    `Check ${c.name}'s own points, rewards or announcements page before withdrawing, and keep a farm log of dates and amounts; the check costs nothing and takes 10 minutes.`,
  ],
};

/** One step kept inside the gate's 20..600 trimmed characters, whatever a long name does to it. */
function fitStep(step: string): string {
  const s = step.trim();
  if (s.length <= 600) return s;
  return `${s.slice(0, 596)}...`;
}

/** A protocol's farm plan: its category playbook plus the variations its own figures call for. */
function farmPlan(p: SnapshotProtocol, age: number | null): string[] {
  const ctx = farmCtx(p, age);
  const key: PlaybookKey = p.category === null ? 'generic' : (PLAYBOOK_BY_CATEGORY[p.category] ?? 'generic');
  const base = PLAYBOOKS[key](ctx);
  const variations: string[] = [];
  if (p.change_7d !== null && p.change_7d >= 10) {
    variations.push(
      `Move a little faster than usual on ${ctx.name}: its TVL is up ${p.change_7d.toFixed(1)}% in the last 7 days, and activity started while a protocol is climbing is the activity its team is watching; bring the next step of this plan forward to this week, at the same gas cost as usual and 15 minutes of time.`,
    );
  } else if (p.change_7d !== null && p.change_7d <= -10) {
    variations.push(
      `Size down on ${ctx.name} for now: its TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in the last 7 days, so start with half the amount this plan suggests, keep the position small until the trend steadies, and review it weekly; the smaller start costs about half the capital and the review takes 10 minutes a week.`,
    );
  }
  if (p.chains.length >= 5) {
    variations.push(
      `Spread your ${ctx.name} activity across its chains: it runs on ${p.chains.length} chains, so repeat your main action on two more of them with small amounts instead of doing everything on ${ctx.chain}; each extra chain costs a few dollars of gas and takes about 15 minutes.`,
    );
  }
  if (age !== null && age >= 730) {
    variations.push(
      `Check ${ctx.name}'s long-running incentive or points history before sizing up: it has been tracked for over two years, so past seasons, old points and expired programs on its own pages tell you what it actually rewards; the research costs nothing and takes about 20 minutes.`,
    );
  }
  let plan = [...base, ...variations];
  if (plan.length > 6) plan = [...base.slice(0, 4), ...variations].slice(0, 6);
  return plan.map(fitStep);
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new Error('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new Error('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new Error(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((ch): ch is string => typeof ch === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** The full build: the ranked board (full-precision factors) and the dashboard's data model. */
export function buildRadar(snapshot: Snapshot): { board: RadarRow[]; radar: RadarData } {
  const peers = peerMultiples(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const preToken = snapshot.protocols.filter(isPreToken);

  // The highest-TVL pre-token protocol of each category, for the leader signal.
  const leaderTvl = new Map<string, number>();
  for (const p of preToken) {
    if (p.category === null) continue;
    const best = leaderTvl.get(p.category);
    if (best === undefined || p.tvl_usd > best) leaderTvl.set(p.category, p.tvl_usd);
  }

  const scored = preToken.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const { multiple, peers: peerCount } = multipleFor(p, peers);
    const momentum = momentumOf(p.change_7d);
    const maturity = maturityOf(age);
    const scope = scopeOf(p.chains);
    const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity * scope));
    return { p, age, multiple, peers: peerCount, momentum, maturity, scope, implied };
  });
  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Strictly decreasing values in rank order: a tie is settled for one dollar less than the row above.
  for (let i = 1; i < scored.length; i++) {
    if (scored[i]!.implied >= scored[i - 1]!.implied) scored[i]!.implied = Math.max(1, scored[i - 1]!.implied - 1);
  }

  const board: RadarRow[] = scored.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    watchlist: watch.has(s.p.slug),
    multiple: s.multiple,
    peers: s.peers,
    momentum: s.momentum,
    maturity: s.maturity,
    scope: s.scope,
    implied_value_usd: s.implied,
    rank: i + 1,
    signals: signalsFor(s.p, s.age, watch.has(s.p.slug), s.p.category !== null && leaderTvl.get(s.p.category) === s.p.tvl_usd),
    farm_steps: farmPlan(s.p, s.age),
  }));

  const categories: Record<string, { peers: number; multiple: number }> = {};
  const categoryNames = new Set<string>();
  for (const p of snapshot.protocols) if (p.category !== null) categoryNames.add(p.category);
  for (const category of [...categoryNames].sort()) {
    const group = peers.byCategory.get(category);
    categories[category] = { peers: group?.peers ?? 0, multiple: group?.multiple ?? peers.globalMedian };
  }

  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    stats: {
      protocols: snapshot.protocols.length,
      pre_token: preToken.length,
      watchlist: snapshot.watchlist.length,
      tokenized: snapshot.protocols.length - preToken.length,
      total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    },
    method: {
      summary:
        'Each pre-token protocol is valued from the snapshot\'s own market. Protocols that already have a token trade at some multiple of the value locked in them; before any median is taken, every tokenized peer\'s market-cap-to-TVL ratio is winsorized at the 95th percentile of all ratios, so one thin-TVL outlier cannot inflate a whole category. The model then takes the median (winsorized) market-cap-to-TVL multiple of the tokenized protocols in a category, shrunk toward the global median with four phantom peers so thin categories borrow the market\'s centre. That multiple is applied to the protocol\'s TVL, then adjusted three ways: for momentum (7-day TVL change, clamped and damped), for maturity (a protocol tracked for three years earns up to 12% more, a brand-new one up to 12% less), and for scope (up to 12% more for the broadest multi-chain footprints). Every pre-token protocol is ranked by the result; protocols with a token never appear, because the market already prices them.',
      global_median: peers.globalMedian,
      winsor_cap: peers.winsorCap,
      categories,
    },
    rows: board,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: RadarRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows, outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (!known.has(r.slug)) return `slug ${r.slug} is not in the snapshot`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `ranks are not exactly 1..${board.length}: rank ${i + 1} reads ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    const v = byRank[i]!.implied_value_usd;
    if (!Number.isSafeInteger(v) || v <= 0) return `${byRank[i]!.slug} has implied value ${v}, not a positive whole dollar amount`;
    if (v > 1e14) return `${byRank[i]!.slug} has implied value ${v}, above the 1e14 cap`;
    if (i > 0 && v > byRank[i - 1]!.implied_value_usd) return `row ${byRank[i]!.rank} outranks row ${byRank[i - 1]!.rank} on implied value`;
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  for (const r of board) {
    const steps = r.farm_steps;
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) return `${r.slug} has ${Array.isArray(steps) ? steps.length : 'no'} farm steps, outside 3..12`;
    for (const s of steps) {
      const len = typeof s === 'string' ? s.trim().length : 0;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} trimmed characters, outside 20..600`;
    }
  }
  return null;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A compact data.js: the dashboard's whole dataset as one script, factors rounded to 4 decimals. */
export function dataScript(radar: RadarData): string {
  const categories: Record<string, { peers: number; multiple: number }> = {};
  for (const [category, v] of Object.entries(radar.method.categories)) {
    categories[category] = { peers: v.peers, multiple: round4(v.multiple) };
  }
  const data = {
    as_of: radar.as_of,
    floor_usd: radar.floor_usd,
    stats: radar.stats,
    method: { summary: radar.method.summary, global_median: round4(radar.method.global_median), winsor_cap: round4(radar.method.winsor_cap), categories },
    rows: radar.rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      watchlist: r.watchlist,
      multiple: round4(r.multiple),
      peers: r.peers,
      momentum: round4(r.momentum),
      maturity: round4(r.maturity),
      scope: round4(r.scope),
      implied_value_usd: r.implied_value_usd,
      rank: r.rank,
      signals: r.signals,
      farm_steps: r.farm_steps,
    })),
  };
  return `window.RADAR_DATA = ${JSON.stringify(data)};\n`;
}
