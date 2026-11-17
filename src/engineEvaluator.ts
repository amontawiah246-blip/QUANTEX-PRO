import { detectContinuation, detectLscc, detectMomentum, detectStructureSweep, detectWickSweep } from './sweepEngines';
import { getGlobalTiming } from './globalConfig';
import { QuantumPipeline, QUANTUM_DEFAULTS } from './quantumPipeline';
import { resolveExpiry } from './executionConfig';
import { HybridEngine, HybridView, viewOf } from './hybridEngine';
import { hybridConfig } from './hybridConfig';
import { HybridModel, loadModel } from './hybridModel';

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface EngineResultData {
  status: string;
  state: string;
  setup: boolean;
  side: 'BUY' | 'SELL' | null;
  confidence: number;
  agree: number;
  candles: number;
  sweep: { side: 'BUY' | 'SELL'; reasons: string[] } | null;
  indicators: { side: 'BUY' | 'SELL'; strategies: string[]; count: number; info: Record<string, number> } | null;
  pattern: { side: 'BUY' | 'SELL'; patterns: string[]; counted: boolean } | null;
  continuation?: { side: 'BUY' | 'SELL'; reasons: string[] } | null;   // sweep + 2 same-colour candles: trade the next open
  momentum?: { side: 'BUY' | 'SELL'; reasons: string[] } | null;       // 3 strong candles in a row: trade the next open
  lscc?: { side: 'BUY' | 'SELL'; reasons: string[] } | null;           // liquidity sweep + a separate confirmation candle: trade the next open
  structureSweep?: { side: 'BUY' | 'SELL'; reasons: string[]; biasDirection?: string; eventType?: string; breakLevel?: number } | null;
  reasons: string[];
  /** Engines 7-12 (structure, repeated sweeps, confirmation). Additive: it never changes `setup`, `side`, `confidence` or the votes above. */
  intelligence?: IntelligenceView;
  /** Hybrid price-action layer (candlestick setup + ADX/ATR/EMA evidence + calibrated probability). Never changes `setup`, `side`, `confidence` or the votes. AutoTrading consumes it only through src/hybridGate.ts (veto-only by default). */
  hybrid?: HybridView;
  rsi?: number;
  trend?: string;
}

export interface IntelligenceView {
  action: 'BUY' | 'SELL' | 'NO_TRADE';
  kind: string | null;
  state: string;
  reason: string;
  trend: string;
  sweepCount: number;
  recentSweeps: number;
  exhaustion: string | null;
  sequence: string | null;
  /** seconds the trade must run: always 300 on a 5-minute chart, chosen from the market condition on other timeframes */
  expirySec: number;
  signalCandleTime: number | null;
  /** earliest moment the order may be sent: the close of the signal candle */
  executeAfter: number | null;
  explanation: unknown;
}

/** Runs the Engines 7-12 pipeline over the closed candles and reports the decision for the newest one. */
export function evaluateIntelligence(candles: CandleData[], tf: number = getGlobalTiming().tfSec): IntelligenceView {
  const pipe = new QuantumPipeline(QUANTUM_DEFAULTS);
  let d = null as ReturnType<QuantumPipeline['step']> | null;
  for (const c of candles.slice(-300)) d = pipe.step({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  const ex = d?.exhaustion?.state ?? null;
  const exp = resolveExpiry(tf, ex);
  return {
    action: d?.action ?? 'NO_TRADE', kind: d?.kind ?? null, state: d?.state ?? 'NORMAL', reason: d?.reason ?? 'no candles', trend: d?.trend ?? 'NEUTRAL',
    sweepCount: d?.sweepCount ?? 0, recentSweeps: d?.recentSweeps ?? 0, exhaustion: ex, sequence: d?.sequence?.classification ?? null,
    expirySec: exp.expirySec, signalCandleTime: d?.action && d.action !== 'NO_TRADE' ? d.time : null, executeAfter: d?.action && d.action !== 'NO_TRADE' ? d.time + tf : null,
    explanation: d?.explanation ?? null,
  };
}

let cachedModel: { path: string; model: HybridModel | null } | null = null;
function hybridModel(): HybridModel | null {
  const path = process.env.HYBRID_MODEL_PATH || 'models/hybrid_model.json';
  if (!cachedModel || cachedModel.path !== path) { let m: HybridModel | null = null; try { m = loadModel(path); } catch { m = null; } cachedModel = { path, model: m }; }
  return cachedModel.model;
}

/** Hybrid verdict for the newest CLOSED candle. 5-minute charts only (the layer is locked to 5-minute candles and a 5-minute expiry). */
export function evaluateHybrid(candles: CandleData[], tf = 300, symbol = 'LIVE'): HybridView {
  const model = hybridModel();
  if (tf !== 300) return { ...viewOf(null, model), reason: `chart timeframe is ${tf}s: the hybrid layer only runs on 5-minute candles`, stage: 'TIMEFRAME' };
  const allow = process.env.HYBRID_ALLOW_SYNTHETIC_MODEL === '1';
  const eng = new HybridEngine(symbol, hybridConfig({ mode: (process.env.HYBRID_MODE as any) || 'AUTO', ml: { allowSyntheticModel: allow } as any, log: { maxRecords: 50, collectFunnel: false } as any }), model);
  let d = null as ReturnType<HybridEngine['step']> | null;
  for (const c of candles.slice(-300)) d = eng.step({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  return viewOf(d, model);
}

export function evaluateEngines(candles: CandleData[], tf: number = getGlobalTiming().tfSec, minInd = 1, symbol?: string): EngineResultData {
  const result = evaluateEnginesCore(candles, tf, minInd);
  try { result.intelligence = evaluateIntelligence(candles, tf); } catch { /* the new engines must never break the existing evaluation */ }
  try { result.hybrid = evaluateHybrid(candles, tf, symbol); } catch { /* neither must the hybrid layer */ }
  return result;
}

function evaluateEnginesCore(candles: CandleData[], tf: number = getGlobalTiming().tfSec, minInd = 1): EngineResultData {
  const cs = candles.slice(-300);
  if (cs.length < 30) {
    return {
      status: 'ok',
      state: `need 30 candles, have ${cs.length}`,
      setup: false,
      side: null,
      confidence: 0,
      agree: 0,
      candles: cs.length,
      sweep: null,
      indicators: null,
      pattern: null,
      structureSweep: null,
      reasons: ['Not enough market history']
    };
  }

  const lastIdx = cs.length - 1;
  const cur = cs[lastIdx];
  const prev = cs[lastIdx - 1];

  // 1. Wick sweep: your original rule (same code the screenshots use). A sweep the context check SKIPS gets no vote.
  const ws = detectWickSweep(cs, lastIdx);
  const sweep: { side: 'BUY' | 'SELL'; reasons: string[] } | null = ws && ws.ok
    ? { side: ws.side, reasons: [ws.side === 'BUY' ? 'Green candle wicked below the previous low, body held above it' : 'Red candle wicked above the previous high, body stayed below it', ...ws.notes] }
    : null;

  // 1b. Sweep continuation (sweep + 2 same-colour candles), 1c. momentum (3 strong candles), 1d. LSCC, 1e. Structure Sweep.
  const co = detectContinuation(cs, lastIdx);
  const continuation = co && co.ok ? { side: co.side, reasons: co.notes } : null;
  const mo = detectMomentum(cs, lastIdx);
  const momentum = mo ? { side: mo.side, reasons: mo.notes } : null;
  const ls = detectLscc(cs, lastIdx);
  const lscc = ls && ls.ok ? { side: ls.side, reasons: ls.trace ?? ls.notes } : null;
  const ss = detectStructureSweep(cs, lastIdx);
  const structureSweep = ss && ss.ok
    ? {
        side: ss.side,
        reasons: ss.trace ?? ss.notes,
        biasDirection: ss.structureMeta?.biasDirection,
        eventType: ss.structureMeta?.eventType,
        breakLevel: ss.structureMeta?.breakLevel,
      }
    : null;

  // 2. Technical Indicators Engine (RSI, EMA, Bollinger, CCI)
  let indSide: 'BUY' | 'SELL' | null = null;
  const indStrategies: string[] = [];

  // RSI calculation
  let gains = 0, losses = 0;
  for (let i = lastIdx - 14; i <= lastIdx; i++) {
    const diff = cs[i].close - cs[i - 1].close;
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / 14;
  const avgLoss = Math.max(0.00001, losses / 14);
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  if (rsi < 32) {
    indStrategies.push(`RSI Oversold (${rsi.toFixed(1)})`);
    indSide = 'BUY';
  } else if (rsi > 68) {
    indStrategies.push(`RSI Overbought (${rsi.toFixed(1)})`);
    indSide = 'SELL';
  }

  // EMA trend check
  let emaFast = 0, emaSlow = 0;
  for (let i = lastIdx - 12; i <= lastIdx; i++) emaFast += cs[i].close;
  for (let i = lastIdx - 26; i <= lastIdx; i++) emaSlow += cs[i].close;
  emaFast /= 13;
  emaSlow /= 27;

  if (emaFast > emaSlow && cur.close > emaFast) {
    if (!indSide || indSide === 'BUY') {
      indSide = 'BUY';
      indStrategies.push('EMA 13/27 Bullish Crossover');
    }
  } else if (emaFast < emaSlow && cur.close < emaFast) {
    if (!indSide || indSide === 'SELL') {
      indSide = 'SELL';
      indStrategies.push('EMA 13/27 Bearish Crossover');
    }
  }

  const indicators = indStrategies.length > 0 && indSide ? {
    side: indSide,
    strategies: indStrategies,
    count: indStrategies.length,
    info: { rsi: Number(rsi.toFixed(1)), emaFast: Number(emaFast.toFixed(2)), emaSlow: Number(emaSlow.toFixed(2)) }
  } : null;

  // 3. Candlestick Pattern Engine
  let patSide: 'BUY' | 'SELL' | null = null;
  const patterns: string[] = [];
  const range = Math.max(0.00001, cur.high - cur.low);
  const body = Math.abs(cur.close - cur.open);
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const upperWick = cur.high - Math.max(cur.open, cur.close);

  if (lowerWick / range >= 0.6 && body / range <= 0.3) {
    patSide = 'BUY';
    patterns.push('Bullish Pinbar / Hammer');
  } else if (upperWick / range >= 0.6 && body / range <= 0.3) {
    patSide = 'SELL';
    patterns.push('Bearish Shooting Star');
  } else if (prev && cur.close > cur.open && prev.close < prev.open && cur.close > prev.open && cur.open < prev.close) {
    patSide = 'BUY';
    patterns.push('Bullish Engulfing Pattern');
  } else if (prev && cur.close < cur.open && prev.close > prev.open && cur.close < prev.close && cur.open > prev.open) {
    patSide = 'SELL';
    patterns.push('Bearish Engulfing Pattern');
  }

  const pattern = patterns.length > 0 && patSide ? {
    side: patSide,
    patterns: patterns,
    counted: true
  } : null;

  // Decision & Confidence logic
  const agreeSides: string[] = [];
  if (sweep) agreeSides.push(sweep.side);
  if (continuation) agreeSides.push(continuation.side);
  if (momentum) agreeSides.push(momentum.side);
  if (lscc) agreeSides.push(lscc.side);
  if (structureSweep) agreeSides.push(structureSweep.side);
  if (indicators) agreeSides.push(indicators.side);
  if (pattern) agreeSides.push(pattern.side);

  if (agreeSides.length === 0) {
    return {
      status: 'ok',
      state: 'no setup',
      setup: false,
      side: null,
      confidence: 0,
      agree: 0,
      candles: cs.length,
      sweep: null,
      indicators: null,
      pattern: null,
      continuation: null,
      momentum: null,
      lscc: null,
      structureSweep: null,
      reasons: ['Scanning live price action']
    };
  }

  // Determine final side
  const buyVotes = agreeSides.filter(s => s === 'BUY').length;
  const sellVotes = agreeSides.filter(s => s === 'SELL').length;

  if (buyVotes > 0 && sellVotes > 0) {
    return {
      status: 'ok',
      state: 'conflicting signals',
      setup: false,
      side: null,
      confidence: 0,
      agree: 0,
      candles: cs.length,
      sweep,
      indicators,
      pattern,
      continuation,
      momentum,
      lscc,
      structureSweep,
      reasons: [`Engines disagree on direction: ${[['sweep', sweep], ['continuation', continuation], ['momentum', momentum], ['LSCC', lscc], ['structureSweep', structureSweep], ['indicators', indicators], ['pattern', pattern]].filter(([, v]: any) => v).map(([n, v]: any) => `${n} ${v.side}`).join(' vs ')}`]
    };
  }

  const side = buyVotes > 0 ? 'BUY' : 'SELL';
  const agreeCount = agreeSides.length;
  // NOT a probability of winning: only a count of agreeing engines. The measured win rate is src/liveConfidence.ts.
  let confidence = 60;
  if (agreeCount === 3) confidence = 85;
  else if (agreeCount === 2) confidence = 75;
  else confidence = 65;

  const reasons: string[] = [];
  if (sweep) reasons.push(`Wick Sweep (${side}): ${sweep.reasons.join(', ')}`);
  if (continuation) reasons.push(`Sweep Continuation (${side}): ${continuation.reasons.join(', ')}`);
  if (momentum) reasons.push(`Momentum (${side}): ${momentum.reasons.join(', ')}`);
  if (lscc) reasons.push(`LSCC (${side}): liquidity sweep confirmed by the next candle`);
  if (structureSweep) reasons.push(`Structure Sweep (${side}): ${structureSweep.reasons.join(', ')}`);
  if (indicators) reasons.push(`Indicators (${side}): ${indicators.strategies.join(', ')}`);
  if (pattern) reasons.push(`Pattern (${side}): ${pattern.patterns.join(', ')}`);

  const trend = emaFast > emaSlow ? 'Bullish' : emaFast < emaSlow ? 'Bearish' : 'Consolidating';

  return {
    status: 'ok',
    state: 'setup',
    setup: true,
    side,
    confidence,
    agree: agreeCount,
    candles: cs.length,
    sweep,
    indicators,
    pattern,
    continuation,
    momentum,
    lscc,
    structureSweep,
    reasons,
    rsi: Number(rsi.toFixed(1)),
    trend
  };
}
