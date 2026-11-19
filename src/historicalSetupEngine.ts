// HSIE — HISTORICAL SETUP INTELLIGENCE ENGINE.
//
// Strictly empirical historical research and context. Its job is NOT to invent a strategy and NEVER to reject
// a valid setup simply because historical matches are sparse or absent ("No historical match != NO_TRADE").
//
// Enforces all five invariants:
//   1. Zero future-candle leakage (historical setups only qualify once entryTime + expirySec <= currentCloseTime).
//   2. Exact expiry simulation using the user's configured tfSec & expirySec (entry at next bar open, settle at exit bar close).
//   3. Separate markets (per-symbol & per-tfSec isolated stores; cross-market counts kept strictly separate).
//   4. Chronological validation split (earlier matches vs recent matches).
//   5. Sample-size awareness (Wilson 95% confidence interval, reliability tier, explicit uncertainty disclosure).
//
// Incrementally updates per-market setup indices as new closed candles arrive so multi-agent scanning never
// rescans entire histories from scratch on every signal.

import { Candle } from './candleMath';
import { indicatorSeries } from './hybridIndicators';
import { computeIndicatorSeries, detectStochRsiSweepSignal } from './stochRsiSweep';
import {
  EngineName,
  detectContinuation,
  detectLscc,
  detectMomentum,
  detectStructureSweep,
  detectWickSweep,
  isFlat,
} from './sweepEngines';

export type HsieResearchStatus = 'STRONG_MATCHES' | 'LIMITED_EVIDENCE' | 'NO_HISTORICAL_MATCH';
export type HsieReliability = 'HIGH' | 'MODERATE' | 'LOW' | 'VERY_LOW' | 'NONE';
export type HsieExpirySimMode = 'SINGLE_BAR' | 'EXACT_MULTI_BAR' | 'APPROXIMATE_SUB_BAR';

export interface SetupFingerprint {
  index: number;
  time: number;
  tfSec: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  engines: string[];
  primaryEngine: string;
  candleAnatomy: {
    bodyRatio: number;
    upperWickRatio: number;
    lowerWickRatio: number;
    sizeVsAtr: number;
    bullish: boolean;
  };
  preceding: {
    prev3NetAtr: number;
    prev1SameDir: boolean;
    prev1BodyRatio: number;
    consecutiveSameDir: number;
  };
  sweep: {
    hasSweep: boolean;
    wickPenetrationAtr: number;
    closeReclaimRatio: number;
  };
  indicators: {
    stochK: number;
    stochD: number;
    stochSlope: number;
    stochZone: 'OVERSOLD' | 'OVERBOUGHT' | 'NEUTRAL';
    rsi: number;
    rsiSlope: number;
  };
  regime: {
    trendLabel: 'BULLISH' | 'BEARISH' | 'RANGING';
    adx: number;
    atrRatio: number;
    emaGapAtr: number;
  };
}

export interface HsieMatchExample {
  time: number;
  iso: string;
  similarity: number;
  engines: string[];
  entryPrice: number;
  settlePrice: number;
  settleTime: number;
  outcome: 'win' | 'loss' | 'tie';
  returnAtr: number;
  regime: string;
  stochK: number;
  rsi: number;
  followThroughAtr: number;
}

export interface TraitProfile {
  count: number;
  avgFollowThroughAtr: number;
  avgBodyRatio: number;
  avgPenetrationAtr: number;
  avgStochK: number;
  avgRsi: number;
  notes: string[];
}

export interface HsieReport {
  market: string;
  tfSec: number;
  expirySec: number;
  side: 'BUY' | 'SELL';
  primaryEngine: string;
  status: HsieResearchStatus;
  reliability: HsieReliability;
  /** HSIE is strictly empirical research and NEVER blocks or rejects trades on its own. */
  allow: true;
  candlesEvaluated: number;
  totalPriorSetups: number;
  similarSetups: number;
  wins: number;
  losses: number;
  ties: number;
  winRatePct: number | null;
  wilson95CI: [number, number] | null;
  breakevenWinRatePct: number;
  payoutUsed: number;
  expectancyPerUnit: number | null;
  expirySimulationMode: HsieExpirySimMode;
  regimeBreakdown: {
    trending: { n: number; wins: number; losses: number; winRatePct: number | null };
    ranging: { n: number; wins: number; losses: number; winRatePct: number | null };
  };
  chronologicalValidation: {
    earlierCount: number;
    earlierWinRatePct: number | null;
    recentCount: number;
    recentWinRatePct: number | null;
  } | null;
  winnerTraits: TraitProfile | null;
  loserTraits: TraitProfile | null;
  currentComparison: string;
  aiHistoricalExplanation: string;
  sampleWarning: string;
  recentExamples: HsieMatchExample[];
  crossMarketSummary: {
    marketsChecked: number;
    totalMatches: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
  } | null;
}

export interface HsieResearchInput {
  symbol: string;
  tfSec: number;
  expirySec: number;
  candles?: readonly Candle[];
  currentCandleTime?: number;
  side: 'BUY' | 'SELL';
  primaryEngine: string;
  activeEngines?: string[];
  payout?: number;
  includeCrossMarket?: boolean;
}

const MAX_STORE_BARS = 2000;
const MIN_WARMUP_BARS = 30;
const EPS = 1e-12;
const round = (n: number, d = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : 0);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const HYBRID_IND_CFG = {
  adx: { period: 14 },
  atr: { period: 14, medianLookback: 100 },
  ema: { fast: 20, slow: 50, slopeLookback: 3 },
};

function wilson95(wins: number, total: number): [number, number] | null {
  if (total <= 0) return null;
  const z = 1.959963984540054;
  const p = wins / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return [round(clamp((center - half) * 100, 0, 100), 1), round(clamp((center + half) * 100, 0, 100), 1)];
}

/** Causal candle-level candlestick detector matching engineEvaluator semantics */
function detectCandlestickPattern(cs: readonly Candle[], i: number): 'BUY' | 'SELL' | null {
  const cur = cs[i];
  const prev = i > 0 ? cs[i - 1] : null;
  const range = Math.max(EPS, cur.high - cur.low);
  const body = Math.abs(cur.close - cur.open);
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  if (lowerWick / range >= 0.6 && body / range <= 0.3) return 'BUY';
  if (upperWick / range >= 0.6 && body / range <= 0.3) return 'SELL';
  if (prev && cur.close > cur.open && prev.close < prev.open && cur.close > prev.open && cur.open < prev.close) return 'BUY';
  if (prev && cur.close < cur.open && prev.close > prev.open && cur.close < prev.close && cur.open > prev.open) return 'SELL';
  return null;
}

function buildFingerprintAt(
  cs: Candle[],
  i: number,
  symbol: string,
  tfSec: number,
  stochRsi: ReturnType<typeof computeIndicatorSeries>,
  hyInd: ReturnType<typeof indicatorSeries>,
  overrideSide?: 'BUY' | 'SELL',
  overridePrimary?: string,
  overrideEngines?: string[]
): SetupFingerprint[] {
  if (i < 15 || i >= cs.length) return [];
  const win = cs.slice(Math.max(0, i - 44), i + 1);
  if (win.length < 15 || win.slice(-8).some(isFlat)) return [];
  const wi = win.length - 1;

  const hitsBySide: Record<'BUY' | 'SELL', string[]> = { BUY: [], SELL: [] };

  const ws = detectWickSweep(win, wi);
  if (ws && ws.ok) hitsBySide[ws.side].push('sweep');
  const co = detectContinuation(win, wi);
  if (co && co.ok) hitsBySide[co.side].push('continuation');
  const mo = detectMomentum(win, wi);
  if (mo && mo.ok) hitsBySide[mo.side].push('momentum');
  const ls = detectLscc(win, wi);
  if (ls && ls.ok) hitsBySide[ls.side].push('lscc');
  const ss = detectStructureSweep(win, wi);
  if (ss && ss.ok) hitsBySide[ss.side].push('structure_sweep');

  const srs = detectStochRsiSweepSignal(cs, i, undefined, stochRsi);
  if (srs) hitsBySide[srs.side].push('stoch_rsi_sweep');

  const pat = detectCandlestickPattern(cs, i);
  if (pat) hitsBySide[pat].push('pattern');

  if (overrideSide && !hitsBySide[overrideSide].length) {
    hitsBySide[overrideSide] = overrideEngines && overrideEngines.length ? [...overrideEngines] : [overridePrimary || 'sweep'];
  }

  const cur = cs[i];
  const prev = cs[i - 1];
  const hy = hyInd[i];
  const atr = Number.isFinite(hy?.atr) && hy.atr > 0 ? hy.atr : Math.max(EPS, cur.high - cur.low);
  const range = Math.max(EPS, cur.high - cur.low);
  const body = Math.abs(cur.close - cur.open);
  const upperWick = cur.high - Math.max(cur.open, cur.close);
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const bullish = cur.close >= cur.open;

  const p3Base = cs[Math.max(0, i - 3)];
  const prev3NetAtr = (prev.close - p3Base.open) / atr;
  const prevRange = Math.max(EPS, prev.high - prev.low);
  const prevBodyRatio = Math.abs(prev.close - prev.open) / prevRange;

  let streak = 0;
  for (let k = i; k >= 1; k--) {
    if ((cs[k].close >= cs[k].open) === bullish) streak++;
    else break;
  }

  const kNow = stochRsi.stochK[i] ?? 50;
  const dNow = stochRsi.stochD[i] ?? 50;
  const kPrev = i > 0 ? stochRsi.stochK[i - 1] ?? kNow : kNow;
  const rNow = stochRsi.rsi[i] ?? 50;
  const rPrev = i > 0 ? stochRsi.rsi[i - 1] ?? rNow : rNow;
  const stochZone: SetupFingerprint['indicators']['stochZone'] =
    kNow <= 25 ? 'OVERSOLD' : kNow >= 75 ? 'OVERBOUGHT' : 'NEUTRAL';

  const adx = Number.isFinite(hy?.adx) ? hy.adx : 18;
  const atrRatio = Number.isFinite(hy?.atrRatio) ? hy.atrRatio : 1;
  const emaGapAtr =
    Number.isFinite(hy?.emaFast) && Number.isFinite(hy?.emaSlow) && Number.isFinite(hy?.atr) && hy.atr > 0
      ? (hy.emaFast - hy.emaSlow) / hy.atr
      : 0;
  const trendLabel: SetupFingerprint['regime']['trendLabel'] =
    adx >= 20 && emaGapAtr > 0.08 ? 'BULLISH' : adx >= 20 && emaGapAtr < -0.08 ? 'BEARISH' : 'RANGING';

  const out: SetupFingerprint[] = [];
  for (const side of ['BUY', 'SELL'] as const) {
    const engines = overrideSide === side && overrideEngines?.length ? [...new Set(overrideEngines)] : hitsBySide[side];
    if (!engines.length) continue;
    const primary = overrideSide === side && overridePrimary ? overridePrimary : engines[0];

    const wickPen = side === 'BUY' ? prev.low - cur.low : cur.high - prev.high;
    const hasSweep = wickPen > 0 || engines.some((e) => e === 'sweep' || e === 'lscc' || e === 'structure_sweep' || e === 'stoch_rsi_sweep');
    const reclaimRatio =
      side === 'BUY'
        ? (cur.close - cur.low) / range
        : (cur.high - cur.close) / range;

    out.push({
      index: i,
      time: cur.time,
      tfSec,
      symbol,
      side,
      engines,
      primaryEngine: primary,
      candleAnatomy: {
        bodyRatio: round(body / range, 4),
        upperWickRatio: round(upperWick / range, 4),
        lowerWickRatio: round(lowerWick / range, 4),
        sizeVsAtr: round(range / atr, 3),
        bullish,
      },
      preceding: {
        prev3NetAtr: round(prev3NetAtr, 3),
        prev1SameDir: (prev.close >= prev.open) === bullish,
        prev1BodyRatio: round(prevBodyRatio, 3),
        consecutiveSameDir: streak,
      },
      sweep: {
        hasSweep,
        wickPenetrationAtr: round(Math.max(0, wickPen) / atr, 3),
        closeReclaimRatio: round(reclaimRatio, 3),
      },
      indicators: {
        stochK: round(kNow, 1),
        stochD: round(dNow, 1),
        stochSlope: round(kNow - kPrev, 2),
        stochZone,
        rsi: round(rNow, 1),
        rsiSlope: round(rNow - rPrev, 2),
      },
      regime: {
        trendLabel,
        adx: round(adx, 1),
        atrRatio: round(atrRatio, 3),
        emaGapAtr: round(emaGapAtr, 3),
      },
    });
  }
  return out;
}

/** Structured multi-feature similarity (0..1) comparing OHLC anatomy, sweep, preceding context, oscillators & regime. */
export function computeSetupSimilarity(cur: SetupFingerprint, hist: SetupFingerprint): number {
  if (cur.side !== hist.side) return 0;

  let weightedSum = 0;
  let totalWeight = 0;
  const add = (sim01: number, weight: number) => {
    weightedSum += clamp(sim01, 0, 1) * weight;
    totalWeight += weight;
  };

  // 1. Strategy engine alignment (0.18)
  const sharedEngines = cur.engines.filter((e) => hist.engines.includes(e)).length;
  const exactPrimary = cur.primaryEngine === hist.primaryEngine;
  add(exactPrimary ? 1 : sharedEngines > 0 ? 0.78 : 0.35, 0.18);

  // 2. Candle anatomy proportions (0.22)
  const diffBody = Math.abs(cur.candleAnatomy.bodyRatio - hist.candleAnatomy.bodyRatio);
  const diffUpper = Math.abs(cur.candleAnatomy.upperWickRatio - hist.candleAnatomy.upperWickRatio);
  const diffLower = Math.abs(cur.candleAnatomy.lowerWickRatio - hist.candleAnatomy.lowerWickRatio);
  const diffSize = Math.min(1, Math.abs(cur.candleAnatomy.sizeVsAtr - hist.candleAnatomy.sizeVsAtr) / 2.2);
  const dirMatch = cur.candleAnatomy.bullish === hist.candleAnatomy.bullish ? 1 : 0.25;
  add(1 - (diffBody * 0.35 + diffUpper * 0.22 + diffLower * 0.22 + diffSize * 0.21), 0.17);
  add(dirMatch, 0.05);

  // 3. Liquidity sweep & reclaim mechanics (0.18)
  const sweepBoth = cur.sweep.hasSweep === hist.sweep.hasSweep ? 1 : 0.4;
  const penDiff = Math.min(1, Math.abs(cur.sweep.wickPenetrationAtr - hist.sweep.wickPenetrationAtr) / 1.5);
  const reclaimDiff = Math.abs(cur.sweep.closeReclaimRatio - hist.sweep.closeReclaimRatio);
  add(sweepBoth * (1 - (penDiff * 0.5 + reclaimDiff * 0.5)), 0.18);

  // 4. Preceding candle price action (0.14)
  const p3Diff = Math.min(1, Math.abs(cur.preceding.prev3NetAtr - hist.preceding.prev3NetAtr) / 3.0);
  const p1Dir = cur.preceding.prev1SameDir === hist.preceding.prev1SameDir ? 1 : 0.35;
  const p1Body = Math.abs(cur.preceding.prev1BodyRatio - hist.preceding.prev1BodyRatio);
  add(1 - (p3Diff * 0.5 + p1Body * 0.25 + (1 - p1Dir) * 0.25), 0.14);

  // 5. Stochastic(14,3,3) + RSI(14) state & slopes (0.16)
  const kDiff = Math.abs(cur.indicators.stochK - hist.indicators.stochK) / 100;
  const rDiff = Math.abs(cur.indicators.rsi - hist.indicators.rsi) / 60;
  const kSlopeAgree = (cur.indicators.stochSlope >= 0) === (hist.indicators.stochSlope >= 0) ? 1 : 0.45;
  const rSlopeAgree = (cur.indicators.rsiSlope >= 0) === (hist.indicators.rsiSlope >= 0) ? 1 : 0.45;
  add((1 - Math.min(1, kDiff * 0.6 + rDiff * 0.4)) * 0.7 + ((kSlopeAgree + rSlopeAgree) / 2) * 0.3, 0.16);

  // 6. Trend & volatility regime (0.12)
  const regimeMatch = cur.regime.trendLabel === hist.regime.trendLabel ? 1 : cur.regime.trendLabel === 'RANGING' || hist.regime.trendLabel === 'RANGING' ? 0.5 : 0.15;
  const adxDiff = Math.min(1, Math.abs(cur.regime.adx - hist.regime.adx) / 35);
  const atrDiff = Math.min(1, Math.abs(cur.regime.atrRatio - hist.regime.atrRatio) / 1.5);
  add(regimeMatch * 0.55 + (1 - adxDiff) * 0.25 + (1 - atrDiff) * 0.2, 0.12);

  return round(weightedSum / Math.max(EPS, totalWeight), 4);
}

interface MarketHistoryIndex {
  symbol: string;
  tfSec: number;
  candles: Candle[];
  indexedUpTo: number; // next candle index to inspect cleanly
  records: SetupFingerprint[];
  stochRsi: ReturnType<typeof computeIndicatorSeries>;
  hyInd: ReturnType<typeof indicatorSeries>;
}

interface SimulatedOutcome {
  entryPrice: number;
  settlePrice: number;
  settleTime: number;
  outcome: 'win' | 'loss' | 'tie';
  returnAtr: number;
  followThroughAtr: number;
  mode: HsieExpirySimMode;
}

/**
 * Simulates trade outcome strictly AFTER historical entry (`candles[idx + 1].open`)
 * respecting `cutoffTime` (the live signal entry instant) so no trade that has not
 * yet finished can leak into historical research.
 */
function simulateHistoricalOutcome(
  candles: readonly Candle[],
  signalIdx: number,
  tfSec: number,
  expirySec: number,
  side: 'BUY' | 'SELL',
  atr: number,
  cutoffTime: number
): SimulatedOutcome | null {
  const entryIdx = signalIdx + 1;
  if (entryIdx >= candles.length) return null;
  const sig = candles[signalIdx];
  const entryBar = candles[entryIdx];
  if (entryBar.time !== sig.time + tfSec) return null; // gap right at entry

  const entryTime = entryBar.time;
  const settleTarget = entryTime + expirySec;

  // ZERO FUTURE-CANDLE LEAKAGE: historical trade must finish before live trade enters!
  if (settleTarget > cutoffTime) return null;

  let exitIdx = entryIdx;
  let mode: HsieExpirySimMode = 'SINGLE_BAR';
  if (expirySec < tfSec) {
    mode = 'APPROXIMATE_SUB_BAR';
    exitIdx = entryIdx;
    // Note: if even single bar hasn't closed by cutoffTime (impossible since settleTarget <= cutoffTime when tfSec matches,
    // wait: if live entry is closeTime and entryBar.time + tfSec > cutoffTime, still ensure entryBar is closed before cutoffTime!)
    if (entryBar.time + tfSec > cutoffTime) return null;
  } else {
    const barsHeld = Math.max(1, Math.ceil(expirySec / tfSec));
    exitIdx = signalIdx + barsHeld;
    mode = barsHeld === 1 && expirySec === tfSec ? 'SINGLE_BAR' : 'EXACT_MULTI_BAR';
    if (exitIdx >= candles.length) return null;
    for (let k = entryIdx + 1; k <= exitIdx; k++) {
      if (candles[k].time - candles[k - 1].time !== tfSec) return null; // gap voids simulation
    }
    const exitBar = candles[exitIdx];
    if (exitBar.time + tfSec > cutoffTime) return null; // ZERO LEAKAGE: exit candle not closed yet at cutoff
  }

  const exitBar = candles[exitIdx];
  const entryPrice = entryBar.open;
  const settlePrice = exitBar.close;
  const settleTime = exitBar.time + tfSec;
  const diff = settlePrice - entryPrice;
  const signedMove = side === 'BUY' ? diff : -diff;
  const outcome: 'win' | 'loss' | 'tie' = signedMove > 0 ? 'win' : signedMove < 0 ? 'loss' : 'tie';
  const denom = Math.max(EPS, atr);
  const immediateMove = side === 'BUY' ? entryBar.close - entryBar.open : entryBar.open - entryBar.close;

  return {
    entryPrice,
    settlePrice,
    settleTime,
    outcome,
    returnAtr: round(signedMove / denom, 3),
    followThroughAtr: round(immediateMove / denom, 3),
    mode,
  };
}

function summarizeTraits(items: Array<{ fp: SetupFingerprint; sim: SimulatedOutcome }>): TraitProfile | null {
  if (!items.length) return null;
  const n = items.length;
  const avg = (fn: (x: { fp: SetupFingerprint; sim: SimulatedOutcome }) => number) =>
    round(items.reduce((s, x) => s + fn(x), 0) / n, 3);
  const avgFollow = avg((x) => x.sim.followThroughAtr);
  const avgBody = avg((x) => x.fp.candleAnatomy.bodyRatio);
  const avgPen = avg((x) => x.fp.sweep.wickPenetrationAtr);
  const avgK = round(avg((x) => x.fp.indicators.stochK), 1);
  const avgRsi = round(avg((x) => x.fp.indicators.rsi), 1);

  const notes: string[] = [];
  if (avgFollow > 0.15) notes.push(`Strong immediate next-candle follow-through (+${avgFollow.toFixed(2)} ATR avg)`);
  else if (avgFollow < -0.05) notes.push(`Weak/negative initial follow-through (${avgFollow.toFixed(2)} ATR avg)`);
  if (avgPen >= 0.25) notes.push(`Deep liquidity sweep rejection (${avgPen.toFixed(2)} ATR wick penetration)`);
  if (avgBody >= 0.55) notes.push(`Decisive signal candle body (${Math.round(avgBody * 100)}% of range)`);
  else if (avgBody <= 0.32) notes.push(`Small signal body / high indecision (${Math.round(avgBody * 100)}% of range)`);
  notes.push(`Avg Stoch %K ${avgK} · Avg RSI ${avgRsi}`);

  return {
    count: n,
    avgFollowThroughAtr: avgFollow,
    avgBodyRatio: avgBody,
    avgPenetrationAtr: avgPen,
    avgStochK: avgK,
    avgRsi,
    notes,
  };
}

export class HistoricalSetupStore {
  private indices = new Map<string, MarketHistoryIndex>();

  clear() {
    this.indices.clear();
  }

  getStats(): { markets: number; totalIndexedSetups: number; byMarket: Array<{ symbol: string; tfSec: number; candles: number; indexedSetups: number; lastCandleTime: number }> } {
    const byMarket: Array<{ symbol: string; tfSec: number; candles: number; indexedSetups: number; lastCandleTime: number }> = [];
    let totalIndexedSetups = 0;
    for (const idx of this.indices.values()) {
      totalIndexedSetups += idx.records.length;
      byMarket.push({
        symbol: idx.symbol,
        tfSec: idx.tfSec,
        candles: idx.candles.length,
        indexedSetups: idx.records.length,
        lastCandleTime: idx.candles.length ? idx.candles[idx.candles.length - 1].time : 0,
      });
    }
    return { markets: this.indices.size, totalIndexedSetups, byMarket };
  }

  /**
   * Incrementally ingests closed candles for `(symbol, tfSec)`.
   * Appends only newly arrived closed bars when timeline extends cleanly; rebuilds only on gaps or resets.
   */
  ingest(symbol: string, tfSec: number, closedCandles: readonly Candle[]): MarketHistoryIndex {
    const cleanSymbol = String(symbol || 'UNKNOWN').trim();
    const key = `${cleanSymbol}|${tfSec}`;
    const sorted = closedCandles
      .filter((c) => c && Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close) && c.closed !== false)
      .slice()
      .sort((a, b) => a.time - b.time);

    // Deduplicate timestamps keeping latest
    const dedupMap = new Map<number, Candle>();
    for (const c of sorted) dedupMap.set(c.time, { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
    const incoming = [...dedupMap.values()];

    let existing = this.indices.get(key);
    if (!existing) {
      const sliced = incoming.slice(-MAX_STORE_BARS);
      existing = {
        symbol: cleanSymbol,
        tfSec,
        candles: sliced,
        indexedUpTo: 15,
        records: [],
        stochRsi: computeIndicatorSeries(sliced),
        hyInd: indicatorSeries(sliced, HYBRID_IND_CFG),
      };
      this.indices.set(key, existing);
    } else if (incoming.length) {
      const lastExistingTime = existing.candles.length ? existing.candles[existing.candles.length - 1].time : -Infinity;
      const newerOnly = incoming.filter((c) => c.time > lastExistingTime);
      const firstIncoming = incoming[0].time;
      const overlapsCleanly = existing.candles.some((c) => c.time === firstIncoming) || firstIncoming > lastExistingTime;

      if (overlapsCleanly && newerOnly.length > 0 && existing.candles.length + newerOnly.length <= MAX_STORE_BARS) {
        existing.candles.push(...newerOnly);
        existing.stochRsi = computeIndicatorSeries(existing.candles);
        existing.hyInd = indicatorSeries(existing.candles, HYBRID_IND_CFG);
      } else if (!overlapsCleanly || incoming.length > existing.candles.length) {
        // Merge existing + incoming preserving oldest deep history up to MAX_STORE_BARS
        const merged = new Map<number, Candle>();
        for (const c of existing.candles) merged.set(c.time, c);
        for (const c of incoming) merged.set(c.time, c);
        const all = [...merged.values()].sort((a, b) => a.time - b.time).slice(-MAX_STORE_BARS);
        const prefixMatches =
          existing.candles.length > 0 &&
          all.length >= existing.candles.length &&
          all[0].time === existing.candles[0].time &&
          all[existing.candles.length - 1].time === existing.candles[existing.candles.length - 1].time;

        existing.candles = all;
        existing.stochRsi = computeIndicatorSeries(all);
        existing.hyInd = indicatorSeries(all, HYBRID_IND_CFG);
        if (!prefixMatches) {
          existing.indexedUpTo = 15;
          existing.records = [];
        }
      }
    }

    // Incrementally index ONLY newly arrived closed bars [indexedUpTo .. length - 1]
    const n = existing.candles.length;
    if (n >= MIN_WARMUP_BARS) {
      const start = Math.max(15, existing.indexedUpTo);
      for (let i = start; i < n; i++) {
        const fps = buildFingerprintAt(existing.candles, i, cleanSymbol, tfSec, existing.stochRsi, existing.hyInd);
        if (fps.length) existing.records.push(...fps);
      }
      existing.indexedUpTo = n;
    }
    return existing;
  }

  /** Researches historical occurrences and outcomes strictly causally before the live entry instant. */
  research(input: HsieResearchInput): HsieReport {
    const payout = Number.isFinite(input.payout) && (input.payout ?? 0) > 0 ? Number(input.payout) : 0.9;
    const breakevenWinRatePct = round((1 / (1 + payout)) * 100, 1);

    let idx = this.indices.get(`${input.symbol}|${input.tfSec}`);
    if (input.candles && input.candles.length) {
      const filtered = input.currentCandleTime != null
        ? input.candles.filter((c) => c.time <= input.currentCandleTime!)
        : input.candles;
      idx = this.ingest(input.symbol, input.tfSec, filtered);
    }

    const emptyMode: HsieExpirySimMode =
      input.expirySec < input.tfSec ? 'APPROXIMATE_SUB_BAR' : input.expirySec === input.tfSec ? 'SINGLE_BAR' : 'EXACT_MULTI_BAR';

    if (!idx || idx.candles.length < MIN_WARMUP_BARS) {
      return {
        market: input.symbol,
        tfSec: input.tfSec,
        expirySec: input.expirySec,
        side: input.side,
        primaryEngine: input.primaryEngine,
        status: 'NO_HISTORICAL_MATCH',
        reliability: 'NONE',
        allow: true,
        candlesEvaluated: idx?.candles.length ?? 0,
        totalPriorSetups: 0,
        similarSetups: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        winRatePct: null,
        wilson95CI: null,
        breakevenWinRatePct,
        payoutUsed: payout,
        expectancyPerUnit: null,
        expirySimulationMode: emptyMode,
        regimeBreakdown: {
          trending: { n: 0, wins: 0, losses: 0, winRatePct: null },
          ranging: { n: 0, wins: 0, losses: 0, winRatePct: null },
        },
        chronologicalValidation: null,
        winnerTraits: null,
        loserTraits: null,
        currentComparison: 'Insufficient closed candle history loaded yet for historical pattern matching.',
        aiHistoricalExplanation: 'Insufficient historical data in the current market buffer; empirical evidence cannot judge this setup yet. Strategy rules remain decisive.',
        sampleWarning: `Only ${idx?.candles.length ?? 0} closed candles indexed (need at least ${MIN_WARMUP_BARS}).`,
        recentExamples: [],
        crossMarketSummary: null,
      };
    }

    const candles = idx.candles;
    const curTime = input.currentCandleTime ?? candles[candles.length - 1].time;
    const curPos = candles.findIndex((c) => c.time === curTime);
    const evalPos = curPos >= 0 ? curPos : candles.length - 1;
    const actualCurTime = candles[evalPos].time;
    const liveEntryCutoff = actualCurTime + input.tfSec;

    const currentFps = buildFingerprintAt(
      candles,
      evalPos,
      input.symbol,
      input.tfSec,
      idx.stochRsi,
      idx.hyInd,
      input.side,
      input.primaryEngine,
      input.activeEngines
    );
    const curFp = currentFps.find((f) => f.side === input.side) ?? currentFps[0];

    const matched: Array<{ fp: SetupFingerprint; sim: SimulatedOutcome; similarity: number }> = [];
    let totalPriorSetups = 0;
    let simModeUsed: HsieExpirySimMode = emptyMode;

    for (const hist of idx.records) {
      if (hist.time >= actualCurTime) continue; // strictly prior setups only
      if (hist.side !== input.side) continue;
      totalPriorSetups++;

      const histIdx = candles[hist.index]?.time === hist.time ? hist.index : candles.findIndex((c) => c.time === hist.time);
      if (histIdx < 0) continue;

      const hy = idx.hyInd[histIdx];
      const atr = Number.isFinite(hy?.atr) && hy.atr > 0 ? hy.atr : Math.max(EPS, candles[histIdx].high - candles[histIdx].low);
      const outcome = simulateHistoricalOutcome(candles, histIdx, input.tfSec, input.expirySec, input.side, atr, liveEntryCutoff);
      if (!outcome) continue;
      simModeUsed = outcome.mode;

      const sim = curFp ? computeSetupSimilarity(curFp, hist) : 0;
      if (sim >= 0.56) {
        matched.push({ fp: hist, sim: outcome, similarity: sim });
      }
    }

    matched.sort((a, b) => b.similarity - a.similarity || b.fp.time - a.fp.time);
    const topMatches = matched.slice(0, 150);
    // Re-sort chronologically for validation split & stats
    const chrono = [...topMatches].sort((a, b) => a.fp.time - b.fp.time);

    const winsArr = chrono.filter((m) => m.sim.outcome === 'win');
    const lossesArr = chrono.filter((m) => m.sim.outcome === 'loss');
    const tiesArr = chrono.filter((m) => m.sim.outcome === 'tie');
    const decided = winsArr.length + lossesArr.length;
    const total = chrono.length;

    const status: HsieResearchStatus =
      total >= 20 ? 'STRONG_MATCHES' : total >= 1 ? 'LIMITED_EVIDENCE' : 'NO_HISTORICAL_MATCH';
    const reliability: HsieReliability =
      total >= 50 ? 'HIGH' : total >= 20 ? 'MODERATE' : total >= 10 ? 'LOW' : total >= 1 ? 'VERY_LOW' : 'NONE';

    const winRatePct = decided > 0 ? round((winsArr.length / decided) * 100, 1) : null;
    const wilsonCI = wilson95(winsArr.length, decided);
    const expectancyPerUnit = decided > 0 ? round((winsArr.length * payout - lossesArr.length) / decided, 3) : null;

    const trendItems = chrono.filter((m) => m.fp.regime.trendLabel !== 'RANGING');
    const rangeItems = chrono.filter((m) => m.fp.regime.trendLabel === 'RANGING');
    const statsFor = (arr: typeof chrono) => {
      const w = arr.filter((x) => x.sim.outcome === 'win').length;
      const l = arr.filter((x) => x.sim.outcome === 'loss').length;
      const d = w + l;
      return { n: arr.length, wins: w, losses: l, winRatePct: d > 0 ? round((w / d) * 100, 1) : null };
    };

    let chronologicalValidation: HsieReport['chronologicalValidation'] = null;
    if (chrono.length >= 8) {
      const mid = Math.floor(chrono.length / 2);
      const early = statsFor(chrono.slice(0, mid));
      const recent = statsFor(chrono.slice(mid));
      chronologicalValidation = {
        earlierCount: early.n,
        earlierWinRatePct: early.winRatePct,
        recentCount: recent.n,
        recentWinRatePct: recent.winRatePct,
      };
    }

    const winnerTraits = summarizeTraits(winsArr);
    const loserTraits = summarizeTraits(lossesArr);

    let sampleWarning = '';
    if (status === 'NO_HISTORICAL_MATCH') {
      sampleWarning = `No close historical match found across ${candles.length} ${input.symbol} candles. Insufficient historical evidence NEVER invalidates a valid setup.`;
    } else if (status === 'LIMITED_EVIDENCE') {
      sampleWarning = `Limited sample (${total} match${total === 1 ? '' : 'es'}, 95% CI ${wilsonCI ? `${wilsonCI[0]}%–${wilsonCI[1]}%` : 'n/a'}). Small sample sizes carry high statistical uncertainty.`;
    } else {
      sampleWarning = `Sample size ${total} matches (95% CI ${wilsonCI ? `${wilsonCI[0]}%–${wilsonCI[1]}%` : 'n/a'}).`;
    }
    if (simModeUsed === 'APPROXIMATE_SUB_BAR') {
      sampleWarning += ` Note: ${input.expirySec}s expiry is shorter than ${input.tfSec}s candles, so historical outcomes reflect single-bar settlement approximations.`;
    }

    let currentComparison = 'No historical baseline to compare against yet.';
    let aiHistoricalExplanation = '';
    if (status === 'NO_HISTORICAL_MATCH') {
      currentComparison = `Current ${input.side} (${input.primaryEngine}) has Stoch %K ${curFp?.indicators.stochK ?? '-'}, RSI ${curFp?.indicators.rsi ?? '-'}, regime ${curFp?.regime.trendLabel ?? '-'}, with 0 close historical matches in ${candles.length} closed bars.`;
      aiHistoricalExplanation = `No similar historical ${input.side} configuration appeared in the available ${candles.length}-candle ${input.symbol} dataset at ${input.tfSec}s/${input.expirySec}s. Proceed strictly by the active strategy rules and live risk controls.`;
    } else {
      const wrText = winRatePct !== null ? `${winRatePct}%` : 'n/a';
      const curStoch = curFp?.indicators.stochK ?? 50;
      const curBody = curFp?.candleAnatomy.bodyRatio ?? 0.5;
      const curPen = curFp?.sweep.wickPenetrationAtr ?? 0;
      const closerToWinners =
        winnerTraits && loserTraits
          ? Math.abs(curBody - winnerTraits.avgBodyRatio) + Math.abs(curPen - winnerTraits.avgPenetrationAtr) <=
            Math.abs(curBody - loserTraits.avgBodyRatio) + Math.abs(curPen - loserTraits.avgPenetrationAtr)
          : (winRatePct ?? 50) >= 50;

      currentComparison = `Current setup (body ${Math.round(curBody * 100)}%, sweep ${curPen.toFixed(2)} ATR, Stoch %K ${curStoch}, ${curFp?.regime.trendLabel ?? 'RANGING'}) aligns more closely with ${closerToWinners ? 'historical winners' : 'historical losers / mixed cases'}.`;
      aiHistoricalExplanation =
        `Similar ${input.side} setups appeared ${total} time${total === 1 ? '' : 's'} in ${input.symbol} (${winsArr.length}W / ${lossesArr.length}L${tiesArr.length ? ` / ${tiesArr.length}T` : ''}, win rate ${wrText}, BE ${breakevenWinRatePct}%). ` +
        (winnerTraits?.notes[0] ? `Winners typically showed: ${winnerTraits.notes[0].toLowerCase()}. ` : '') +
        (loserTraits?.notes[0] ? `Losses more often showed: ${loserTraits.notes[0].toLowerCase()}. ` : '') +
        currentComparison;
    }

    let crossMarketSummary: HsieReport['crossMarketSummary'] = null;
    if (input.includeCrossMarket && curFp) {
      let marketsChecked = 0;
      let cmTotal = 0;
      let cmWins = 0;
      let cmLosses = 0;
      for (const other of this.indices.values()) {
        if (other.symbol === input.symbol || other.tfSec !== input.tfSec || other.candles.length < MIN_WARMUP_BARS) continue;
        marketsChecked++;
        const otherCutoff = other.candles[other.candles.length - 1].time + other.tfSec;
        for (const h of other.records) {
          if (h.side !== input.side) continue;
          const hIdx = other.candles[h.index]?.time === h.time ? h.index : other.candles.findIndex((c) => c.time === h.time);
          if (hIdx < 0) continue;
          const atr = Math.max(EPS, other.hyInd[hIdx]?.atr || (other.candles[hIdx].high - other.candles[hIdx].low));
          const sim = computeSetupSimilarity(curFp, h);
          if (sim < 0.62) continue;
          const out = simulateHistoricalOutcome(other.candles, hIdx, other.tfSec, input.expirySec, input.side, atr, otherCutoff);
          if (!out) continue;
          cmTotal++;
          if (out.outcome === 'win') cmWins++;
          else if (out.outcome === 'loss') cmLosses++;
        }
      }
      if (marketsChecked > 0) {
        const dec = cmWins + cmLosses;
        crossMarketSummary = {
          marketsChecked,
          totalMatches: cmTotal,
          wins: cmWins,
          losses: cmLosses,
          winRatePct: dec > 0 ? round((cmWins / dec) * 100, 1) : null,
        };
      }
    }

    const recentExamples: HsieMatchExample[] = [...chrono]
      .reverse()
      .slice(0, 8)
      .map((m) => ({
        time: m.fp.time,
        iso: new Date(m.fp.time * 1000).toISOString(),
        similarity: m.similarity,
        engines: m.fp.engines,
        entryPrice: m.sim.entryPrice,
        settlePrice: m.sim.settlePrice,
        settleTime: m.sim.settleTime,
        outcome: m.sim.outcome,
        returnAtr: m.sim.returnAtr,
        regime: m.fp.regime.trendLabel,
        stochK: m.fp.indicators.stochK,
        rsi: m.fp.indicators.rsi,
        followThroughAtr: m.sim.followThroughAtr,
      }));

    return {
      market: input.symbol,
      tfSec: input.tfSec,
      expirySec: input.expirySec,
      side: input.side,
      primaryEngine: input.primaryEngine,
      status,
      reliability,
      allow: true,
      candlesEvaluated: evalPos + 1,
      totalPriorSetups,
      similarSetups: total,
      wins: winsArr.length,
      losses: lossesArr.length,
      ties: tiesArr.length,
      winRatePct,
      wilson95CI: wilsonCI,
      breakevenWinRatePct,
      payoutUsed: payout,
      expectancyPerUnit,
      expirySimulationMode: simModeUsed,
      regimeBreakdown: {
        trending: statsFor(trendItems),
        ranging: statsFor(rangeItems),
      },
      chronologicalValidation,
      winnerTraits,
      loserTraits,
      currentComparison,
      aiHistoricalExplanation,
      sampleWarning,
      recentExamples,
      crossMarketSummary,
    };
  }
}

export const hsieStore = new HistoricalSetupStore();

export function hsiePromptSection(report: HsieReport | null | undefined): string {
  if (!report) return 'HISTORICAL SETUP INTELLIGENCE (HSIE): not available.';
  const compact = {
    market: report.market,
    tfSec: report.tfSec,
    expirySec: report.expirySec,
    status: report.status,
    reliability: report.reliability,
    similarSetups: report.similarSetups,
    wins: report.wins,
    losses: report.losses,
    ties: report.ties,
    winRatePct: report.winRatePct,
    wilson95CI: report.wilson95CI,
    breakevenWinRatePct: report.breakevenWinRatePct,
    expectancyPerUnit: report.expectancyPerUnit,
    regimeBreakdown: report.regimeBreakdown,
    chronologicalValidation: report.chronologicalValidation,
    currentComparison: report.currentComparison,
    aiHistoricalExplanation: report.aiHistoricalExplanation,
    sampleWarning: report.sampleWarning,
  };
  return [
    'HISTORICAL SETUP INTELLIGENCE (HSIE — empirical historical research ONLY; NEVER reject a valid strategy setup because matches are zero or few):',
    JSON.stringify(compact, null, 1),
    'Use this to explain historical evidence, sample-size uncertainty, and risks in your explanation/warnings.',
  ].join('\n');
}
