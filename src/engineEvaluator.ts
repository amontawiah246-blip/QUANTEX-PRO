import { detectContinuation, detectLscc, detectMomentum, detectStructureSweep, detectWickSweep } from './sweepEngines';
import { getGlobalTiming } from './globalConfig';
import { QuantumPipeline, QUANTUM_DEFAULTS } from './quantumPipeline';
import { resolveExpiry } from './executionConfig';
import { HybridEngine, HybridView, viewOf } from './hybridEngine';
import { hybridConfig } from './hybridConfig';
import { HybridModel, loadModel } from './hybridModel';
import { computeIndicatorSeries, detectStochRsiSweepSignal } from './stochRsiSweep';
import { hsieStore, type HsieReport } from './historicalSetupEngine';
import { assessQuantumSweepIntel, type QsiAssessment } from './quantumSweepIntel';

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
  stochRsiSweep?: { side: 'BUY' | 'SELL'; reasons: string[]; stochK: number; stochD: number; rsi: number; confirmations: string[] } | null;
  reasons: string[];
  /** Engines 7-12 (structure, repeated sweeps, confirmation). Additive: it never changes `setup`, `side`, `confidence` or the votes above. */
  intelligence?: IntelligenceView;
  /** Hybrid price-action layer (candlestick setup + ADX/ATR/EMA evidence + calibrated probability). Runs on all global timeframes & expiries. */
  hybrid?: HybridView;
  /** HSIE — Historical Setup Intelligence Engine empirical research (strictly non-blocking). */
  hsie?: HsieReport | null;
  /** QSI — Quantum Sweep Intelligence unified false-move risk & engine participation summary. */
  qsi?: QsiAssessment | null;
  rsi?: number;
  stochK?: number;
  stochD?: number;
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
  /** seconds the trade must run: respects user-selected global expiry when supplied */
  expirySec: number;
  signalCandleTime: number | null;
  /** earliest moment the order may be sent: the close of the signal candle */
  executeAfter: number | null;
  explanation: unknown;
}

/** Runs the Engines 7-12 pipeline over the closed candles and reports the decision for the newest one. */
export function evaluateIntelligence(candles: CandleData[], tf: number = getGlobalTiming().tfSec, expirySec?: number): IntelligenceView {
  const pipe = new QuantumPipeline(QUANTUM_DEFAULTS);
  let d = null as ReturnType<QuantumPipeline['step']> | null;
  for (const c of candles.slice(-300)) d = pipe.step({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  const ex = d?.exhaustion?.state ?? null;
  const resolved = expirySec && expirySec > 0 ? expirySec : resolveExpiry(tf, ex).expirySec;
  return {
    action: d?.action ?? 'NO_TRADE', kind: d?.kind ?? null, state: d?.state ?? 'NORMAL', reason: d?.reason ?? 'no candles', trend: d?.trend ?? 'NEUTRAL',
    sweepCount: d?.sweepCount ?? 0, recentSweeps: d?.recentSweeps ?? 0, exhaustion: ex, sequence: d?.sequence?.classification ?? null,
    expirySec: resolved, signalCandleTime: d?.action && d.action !== 'NO_TRADE' ? d.time : null, executeAfter: d?.action && d.action !== 'NO_TRADE' ? d.time + tf : null,
    explanation: d?.explanation ?? null,
  };
}

let cachedModel: { path: string; model: HybridModel | null } | null = null;
function hybridModel(): HybridModel | null {
  const path = process.env.HYBRID_MODEL_PATH || 'models/hybrid_model.json';
  if (!cachedModel || cachedModel.path !== path) { let m: HybridModel | null = null; try { m = loadModel(path); } catch { m = null; } cachedModel = { path, model: m }; }
  return cachedModel.model;
}

/** Hybrid verdict for the newest CLOSED candle across any active timeframe and expiry. */
export function evaluateHybrid(candles: CandleData[], tf: number = getGlobalTiming().tfSec, symbol = 'LIVE', expirySec: number = getGlobalTiming().expirySec): HybridView {
  const model = hybridModel();
  const safeTf = tf > 0 ? tf : 60;
  const safeExp = expirySec > 0 ? expirySec : safeTf;
  const allow = process.env.HYBRID_ALLOW_SYNTHETIC_MODEL === '1';
  const eng = new HybridEngine(symbol, hybridConfig({
    mode: (process.env.HYBRID_MODE as any) || 'AUTO',
    tfSec: safeTf,
    expirySec: safeExp,
    ml: { allowSyntheticModel: allow } as any,
    log: { maxRecords: 50, collectFunnel: false } as any,
  }), model);
  let d = null as ReturnType<HybridEngine['step']> | null;
  for (const c of candles.slice(-300)) d = eng.step({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  return viewOf(d, model);
}

export function evaluateEngines(candles: CandleData[], tf: number = getGlobalTiming().tfSec, minInd = 1, symbol?: string, expirySec?: number): EngineResultData {
  const activeExp = expirySec && expirySec > 0 ? expirySec : getGlobalTiming().expirySec;
  const result = evaluateEnginesCore(candles, tf, minInd);
  try { result.intelligence = evaluateIntelligence(candles, tf, expirySec); } catch { /* the new engines must never break the existing evaluation */ }
  try { result.hybrid = evaluateHybrid(candles, tf, symbol || 'LIVE', activeExp); } catch { /* neither must the hybrid layer */ }

  if (result.setup && result.side && candles.length >= 30) {
    const activeEngines: string[] = [];
    if (result.sweep) activeEngines.push('sweep');
    if (result.continuation) activeEngines.push('continuation');
    if (result.momentum) activeEngines.push('momentum');
    if (result.lscc) activeEngines.push('lscc');
    if (result.structureSweep) activeEngines.push('structure_sweep');
    if (result.stochRsiSweep) activeEngines.push('stoch_rsi_sweep');
    if (result.pattern) activeEngines.push('pattern');
    const primaryEngine = activeEngines[0] || 'sweep';

    try {
      result.hsie = hsieStore.research({
        symbol: symbol || 'LIVE',
        tfSec: tf,
        expirySec: activeExp,
        candles,
        side: result.side,
        primaryEngine,
        activeEngines,
        includeCrossMarket: true,
      });
    } catch {
      result.hsie = null;
    }

    try {
      result.qsi = assessQuantumSweepIntel({
        side: result.side,
        primaryEngine,
        activeEngines,
        candles,
        tfSec: tf,
        expirySec: activeExp,
        intelligence: result.intelligence,
        hybrid: result.hybrid,
        hsie: result.hsie ?? null,
      });
    } catch {
      result.qsi = null;
    }
  }
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
  let ss = detectStructureSweep(cs, lastIdx);
  if ((!ss || !ss.ok) && cs.length > 45) {
    const ssAgent = detectStructureSweep(cs.slice(-45), 44);
    if (ssAgent && ssAgent.ok) ss = ssAgent;
  }
  let structureSweep: EngineResultData['structureSweep'] = ss && ss.ok
    ? {
        side: ss.side,
        reasons: ss.trace ?? ss.notes,
        biasDirection: ss.structureMeta?.biasDirection,
        eventType: ss.structureMeta?.eventType,
        breakLevel: ss.structureMeta?.breakLevel,
      }
    : null;

  // 2. Stochastic(14,3,3) + RSI(14) + Lookback Sweep/Pattern Engine (replaces old RSI/EMA vote)
  const indSeries = computeIndicatorSeries(cs);
  const rsi = indSeries.rsi[lastIdx];
  const stochK = indSeries.stochK[lastIdx];
  const stochD = indSeries.stochD[lastIdx];

  let srs = detectStochRsiSweepSignal(cs, lastIdx, undefined, indSeries);
  if (!srs && cs.length > 45) {
    srs = detectStochRsiSweepSignal(cs.slice(-45), 44);
  }
  let stochRsiSweep: EngineResultData['stochRsiSweep'] = srs
    ? {
        side: srs.side,
        reasons: srs.reasons,
        stochK: srs.stochK,
        stochD: srs.stochD,
        rsi: srs.rsi,
        confirmations: srs.confirmations.map((c) => c.label),
      }
    : null;

  let indicators: EngineResultData['indicators'] = srs
    ? {
        side: srs.side,
        strategies: [srs.stochTrigger, srs.rsiTrigger],
        count: 2,
        info: {
          rsi: srs.rsi,
          stochK: srs.stochK,
          stochD: srs.stochD,
        },
      }
    : null;

  // EMA fast/slow retained purely for market trend label
  let emaFast = 0, emaSlow = 0;
  for (let i = lastIdx - 12; i <= lastIdx; i++) emaFast += cs[i].close;
  for (let i = lastIdx - 26; i <= lastIdx; i++) emaSlow += cs[i].close;
  emaFast /= 13;
  emaSlow /= 27;

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

  let pattern: EngineResultData['pattern'] = patterns.length > 0 && patSide ? {
    side: patSide,
    patterns: patterns,
    counted: true
  } : null;

  let sweepMut = sweep;
  let contMut = continuation;
  let momMut = momentum;
  let lsccMut = lscc;

  // Weighted vote accounting so a weak contextual candlestick pattern (or isolated weak vote against a multi-engine confluence)
  // never kills a genuine high-edge setup, while genuine two-way major structural conflicts still halt cleanly.
  const votes: Array<{ name: string; side: 'BUY' | 'SELL'; weight: number; major: boolean }> = [];
  if (sweepMut) votes.push({ name: 'sweep', side: sweepMut.side, weight: 1.2, major: true });
  if (contMut) votes.push({ name: 'continuation', side: contMut.side, weight: 1.8, major: true });
  if (momMut) votes.push({ name: 'momentum', side: momMut.side, weight: 1.5, major: true });
  if (lsccMut) votes.push({ name: 'LSCC', side: lsccMut.side, weight: 2.0, major: true });
  if (structureSweep) votes.push({ name: 'structureSweep', side: structureSweep.side, weight: 2.0, major: true });
  if (stochRsiSweep) votes.push({ name: 'stochRsiSweep', side: stochRsiSweep.side, weight: 2.5, major: true });
  if (pattern) votes.push({ name: 'pattern', side: pattern.side, weight: 0.6, major: false });

  if (votes.length === 0) {
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
      stochRsiSweep: null,
      rsi: Number(rsi.toFixed(1)),
      stochK: Number(stochK.toFixed(1)),
      stochD: Number(stochD.toFixed(1)),
      reasons: ['Scanning live price action']
    };
  }

  const buyVotes = votes.filter((v) => v.side === 'BUY');
  const sellVotes = votes.filter((v) => v.side === 'SELL');
  const buyWeight = buyVotes.reduce((s, v) => s + v.weight, 0);
  const sellWeight = sellVotes.reduce((s, v) => s + v.weight, 0);
  const majorBuy = buyVotes.filter((v) => v.major).length;
  const majorSell = sellVotes.filter((v) => v.major).length;

  let dissentNote: string | null = null;
  let side: 'BUY' | 'SELL';
  if (buyVotes.length > 0 && sellVotes.length > 0) {
    const hiW = Math.max(buyWeight, sellWeight);
    const loW = Math.min(buyWeight, sellWeight);
    const genuineMajorConflict = majorBuy > 0 && majorSell > 0 && hiW < loW * 1.65;
    if (genuineMajorConflict || Math.abs(buyWeight - sellWeight) < 0.7) {
      return {
        status: 'ok',
        state: 'conflicting signals',
        setup: false,
        side: null,
        confidence: 0,
        agree: 0,
        candles: cs.length,
        sweep: sweepMut,
        indicators,
        pattern,
        continuation: contMut,
        momentum: momMut,
        lscc: lsccMut,
        structureSweep,
        stochRsiSweep,
        rsi: Number(rsi.toFixed(1)),
        stochK: Number(stochK.toFixed(1)),
        stochD: Number(stochD.toFixed(1)),
        reasons: [`Engines disagree on direction: ${votes.map((v) => `${v.name} ${v.side}`).join(' vs ')}`]
      };
    }
    side = buyWeight > sellWeight ? 'BUY' : 'SELL';
    const overruled = votes.filter((v) => v.side !== side);
    dissentNote = `Dominant ${side} confluence (${Math.max(buyWeight, sellWeight).toFixed(1)} vs ${Math.min(buyWeight, sellWeight).toFixed(1)}); minor dissent noted (${overruled.map((v) => `${v.name} ${v.side}`).join(', ')})`;
    if (sweepMut && sweepMut.side !== side) sweepMut = null;
    if (contMut && contMut.side !== side) contMut = null;
    if (momMut && momMut.side !== side) momMut = null;
    if (lsccMut && lsccMut.side !== side) lsccMut = null;
    if (structureSweep && structureSweep.side !== side) structureSweep = null;
    if (stochRsiSweep && stochRsiSweep.side !== side) { stochRsiSweep = null; indicators = null; }
    if (pattern && pattern.side !== side) pattern = null;
  } else {
    side = buyVotes.length > 0 ? 'BUY' : 'SELL';
  }

  const agreeCount = votes.filter((v) => v.side === side).length;
  // NOT a probability of winning: only a count of agreeing engines. The measured win rate is src/liveConfidence.ts.
  let confidence = 65;
  if (agreeCount >= 3) confidence = 85;
  else if (agreeCount === 2) confidence = 75;
  else if (lsccMut || structureSweep) confidence = 75;
  if (srs && stochRsiSweep) {
    confidence = Math.max(confidence, srs.confidenceScore);
  }
  if (dissentNote) confidence = Math.max(60, confidence - 5);

  const reasons: string[] = [];
  if (stochRsiSweep) reasons.push(`Stoch+RSI+Confirm (${side}): ${stochRsiSweep.reasons.join(' | ')}`);
  if (sweepMut) reasons.push(`Wick Sweep (${side}): ${sweepMut.reasons.join(', ')}`);
  if (contMut) reasons.push(`Sweep Continuation (${side}): ${contMut.reasons.join(', ')}`);
  if (momMut) reasons.push(`Momentum (${side}): ${momMut.reasons.join(', ')}`);
  if (lsccMut) reasons.push(`LSCC (${side}): liquidity sweep confirmed by the next candle`);
  if (structureSweep) reasons.push(`Structure Sweep (${side}): ${structureSweep.reasons.join(', ')}`);
  if (indicators && !stochRsiSweep) reasons.push(`Indicators (${side}): ${indicators.strategies.join(', ')}`);
  if (pattern) reasons.push(`Pattern (${side}): ${pattern.patterns.join(', ')}`);
  if (dissentNote) reasons.push(dissentNote);

  const trend = emaFast > emaSlow ? 'Bullish' : emaFast < emaSlow ? 'Bearish' : 'Consolidating';

  return {
    status: 'ok',
    state: 'setup',
    setup: true,
    side,
    confidence,
    agree: agreeCount,
    candles: cs.length,
    sweep: sweepMut,
    indicators,
    pattern,
    continuation: contMut,
    momentum: momMut,
    lscc: lsccMut,
    structureSweep,
    stochRsiSweep,
    reasons,
    rsi: Number(rsi.toFixed(1)),
    stochK: Number(stochK.toFixed(1)),
    stochD: Number(stochD.toFixed(1)),
    trend
  };
}
