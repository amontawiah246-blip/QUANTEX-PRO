// QSI — QUANTUM SWEEP INTELLIGENCE & UNIFIED ENGINE ORCHESTRATOR.
//
// Evaluates false-move risk and structural confluence across ALL active engines:
//   - Core Strategy Engines (sweep, continuation, momentum, lscc, structure_sweep, stoch_rsi_sweep, pattern)
//   - Quantum Pipeline (Engines 7-12: market structure, repeated sweeps, exhaustion, sequence)
//   - Hybrid Engine (Stage 2 ADX/ATR/EMA evidence + calibrated probability when model present)
//   - Market Quality (regime, trend alignment, indicator alignment, volatility)
//   - HSIE (Historical Setup Intelligence Engine empirical baseline)
//
// Critical Rules:
//   1. Never invents trades, and NEVER deletes/weakens any original strategy rule.
//   2. Does NOT require CHoCH/MSS/BOS or historical matches to endorse a valid setup.
//   3. Missing or sparse HSIE evidence NEVER counts as false-move risk ("No historical match != NO_TRADE").
//   4. Defaults to 'shadow' mode (QSI_MODE=shadow|veto) so existing valid strategies remain executable
//      while receiving full false-move telemetry, risk scoring, and AI explanation context.

import { Candle } from './candleMath';
import type { HsieReport } from './historicalSetupEngine';
import type { HybridView } from './hybridEngine';
import { indicatorSeries } from './hybridIndicators';
import type { MarketQuality } from './marketQuality';
import { computeIndicatorSeries } from './stochRsiSweep';

export type QsiMode = 'shadow' | 'veto';
export type QsiRecommendation = 'PASS' | 'CAUTION' | 'VETO';

export interface QsiComponentScores {
  sweepAnatomy: number;       // 0..100 (higher = cleaner, lower false-move risk)
  rejectionQuality: number;   // 0..100
  momentumExhaustion: number; // 0..100 (higher = healthy momentum, lower exhaustion/trap risk)
  contextStructure: number;   // 0..100 (higher = better structure/quality/hybrid agreement)
  historicalContext: number;  // 0..100 (50 neutral when NO_HISTORICAL_MATCH or sparse)
}

export interface QsiAssessment {
  mode: QsiMode;
  recommendation: QsiRecommendation;
  allow: boolean;
  falseMoveRiskScore: number; // 0..100 (higher = greater risk of false move / liquidity trap)
  confidenceAdjustment: number;
  componentScores: QsiComponentScores;
  engineParticipation: string[];
  observations: string[];
  conflicts: string[];
  summary: string;
}

export interface QsiInput {
  side: 'BUY' | 'SELL';
  primaryEngine: string;
  activeEngines: string[];
  candles: readonly Candle[];
  tfSec: number;
  expirySec: number;
  intelligence?: {
    action: 'BUY' | 'SELL' | 'NO_TRADE';
    kind: string | null;
    state: string;
    trend: string;
    sweepCount: number;
    recentSweeps: number;
    exhaustion: string | null;
    sequence: string | null;
  } | null;
  hybrid?: HybridView | null;
  quality?: MarketQuality | null;
  hsie?: HsieReport | null;
}

const EPS = 1e-12;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export function qsiModeFromEnv(env: Record<string, string | undefined> = process.env): QsiMode {
  return String(env.QSI_MODE ?? '').trim().toLowerCase() === 'veto' ? 'veto' : 'shadow';
}

export function assessQuantumSweepIntel(input: QsiInput, mode: QsiMode = qsiModeFromEnv()): QsiAssessment {
  const cs = input.candles;
  const n = cs.length;
  const observations: string[] = [];
  const conflicts: string[] = [];
  const participation = new Set<string>(input.activeEngines.filter(Boolean));
  if (input.primaryEngine) participation.add(input.primaryEngine);
  if (input.intelligence) participation.add(`quantum_pipeline(${input.intelligence.state})`);
  if (input.hybrid) participation.add(`hybrid(${input.hybrid.mode ?? input.hybrid.stage})`);
  if (input.quality) participation.add(`market_quality(${input.quality.grade})`);
  if (input.hsie) participation.add(`hsie(${input.hsie.status})`);

  if (n < 15) {
    return {
      mode,
      recommendation: 'PASS',
      allow: true,
      falseMoveRiskScore: 30,
      confidenceAdjustment: 0,
      componentScores: {
        sweepAnatomy: 65,
        rejectionQuality: 65,
        momentumExhaustion: 65,
        contextStructure: 65,
        historicalContext: 50,
      },
      engineParticipation: [...participation],
      observations: ['Warmup candle window; baseline neutral false-move score applied.'],
      conflicts: [],
      summary: `QSI ${mode.toUpperCase()}: neutral warmup baseline across ${participation.size} engine layer(s).`,
    };
  }

  const lastIdx = n - 1;
  const cur = cs[lastIdx];
  const prev = cs[lastIdx - 1];
  const range = Math.max(EPS, cur.high - cur.low);
  const body = Math.abs(cur.close - cur.open);
  const bodyRatio = body / range;
  const closePos = input.side === 'BUY' ? (cur.close - cur.low) / range : (cur.high - cur.close) / range;

  const hyInd = indicatorSeries(cs as Candle[], {
    adx: { period: 14 },
    atr: { period: 14, medianLookback: 100 },
    ema: { fast: 20, slow: 50, slopeLookback: 3 },
  });
  const atr = Math.max(EPS, hyInd[lastIdx]?.atr || range);
  const atrRatio = Number.isFinite(hyInd[lastIdx]?.atrRatio) ? hyInd[lastIdx].atrRatio : 1;

  const stochRsi = computeIndicatorSeries(cs);
  const kNow = stochRsi.stochK[lastIdx] ?? 50;
  const dNow = stochRsi.stochD[lastIdx] ?? 50;
  const rsiNow = stochRsi.rsi[lastIdx] ?? 50;

  // 1. Sweep Anatomy (0..100)
  const isSweepType = input.activeEngines.some((e) =>
    e === 'sweep' || e === 'lscc' || e === 'structure_sweep' || e === 'stoch_rsi_sweep'
  );
  const wickPen = input.side === 'BUY' ? Math.max(0, prev.low - cur.low) : Math.max(0, cur.high - prev.high);
  const penAtr = wickPen / atr;
  let sweepAnatomy = 68;
  if (isSweepType) {
    if (penAtr >= 0.15 && penAtr <= 1.6 && closePos >= 0.55) {
      sweepAnatomy = 82;
      observations.push(`Clean liquidity sweep (${penAtr.toFixed(2)} ATR penetration, ${Math.round(closePos * 100)}% reclaim).`);
    } else if (penAtr > 2.4) {
      sweepAnatomy = 44;
      conflicts.push(`Oversized sweep spike (${penAtr.toFixed(2)} ATR) carries mean-reversion overshoot risk.`);
    } else if (closePos < 0.38) {
      sweepAnatomy = 48;
      conflicts.push(`Weak reclaim after sweep (close at ${Math.round(closePos * 100)}% of candle range).`);
    }
  } else {
    // Continuation / momentum / pattern setups are scored cleanly on candle close conviction
    sweepAnatomy = closePos >= 0.65 && bodyRatio >= 0.5 ? 80 : 65;
  }

  // 2. Rejection & Oscillator Confirmation Quality (0..100)
  let rejectionQuality = 65;
  const sideAlignedCandle = input.side === 'BUY' ? cur.close > cur.open : cur.close < cur.open;
  if (sideAlignedCandle && bodyRatio >= 0.35) rejectionQuality += 10;
  if (closePos >= 0.62) rejectionQuality += 8;
  if (input.side === 'BUY' && kNow > dNow && kNow <= 45) {
    rejectionQuality += 10;
    observations.push(`Stoch(14,3,3) turning up (%K ${kNow.toFixed(1)} > %D ${dNow.toFixed(1)}) supportive for BUY.`);
  } else if (input.side === 'SELL' && kNow < dNow && kNow >= 55) {
    rejectionQuality += 10;
    observations.push(`Stoch(14,3,3) turning down (%K ${kNow.toFixed(1)} < %D ${dNow.toFixed(1)}) supportive for SELL.`);
  } else if ((input.side === 'BUY' && kNow >= 85 && rsiNow >= 72) || (input.side === 'SELL' && kNow <= 15 && rsiNow <= 28)) {
    rejectionQuality -= 20;
    conflicts.push(`Oscillator extreme against ${input.side} entry (Stoch %K ${kNow.toFixed(1)}, RSI ${rsiNow.toFixed(1)}).`);
  }
  rejectionQuality = clamp(rejectionQuality, 15, 98);

  // 3. Momentum & Exhaustion Risk (0..100)
  const p3Open = cs[Math.max(0, lastIdx - 3)].open;
  const net3Atr = (cur.close - p3Open) / atr;
  let momentumExhaustion = 72;
  const ex = input.intelligence?.exhaustion ?? null;
  if (ex === 'EXHAUSTION' || ex === 'LATE_EXHAUSTION') {
    momentumExhaustion -= 24;
    conflicts.push(`Quantum Pipeline flags ${ex} on recent bars.`);
  } else if (ex === 'CONTINUATION') {
    momentumExhaustion += 10;
  }
  if ((input.side === 'BUY' && net3Atr > 3.2) || (input.side === 'SELL' && net3Atr < -3.2)) {
    momentumExhaustion -= 20;
    conflicts.push(`Overextended 3-candle impulse (${Math.abs(net3Atr).toFixed(2)} ATR) increases pullback risk.`);
  }
  if (atrRatio > 2.4) {
    momentumExhaustion -= 15;
    conflicts.push(`Volatility spike (${atrRatio.toFixed(2)}x median ATR).`);
  } else if (atrRatio < 0.45) {
    momentumExhaustion -= 10;
    observations.push(`Compressed volatility (${atrRatio.toFixed(2)}x median ATR).`);
  }
  momentumExhaustion = clamp(momentumExhaustion, 15, 98);

  // 4. Context & Cross-Engine Agreement Structure (0..100)
  let contextStructure = 64;
  if (input.activeEngines.length >= 2) {
    contextStructure += Math.min(18, (input.activeEngines.length - 1) * 8);
    observations.push(`Multi-engine confluence (${input.activeEngines.length} engines: ${input.activeEngines.join(', ')}).`);
  }
  if (input.intelligence) {
    if (input.intelligence.action === input.side) {
      contextStructure += 12;
      observations.push(`QuantumPipeline (Engines 7-12) independently agrees on ${input.side}.`);
    } else if (input.intelligence.action !== 'NO_TRADE' && input.intelligence.action !== input.side) {
      contextStructure -= 18;
      conflicts.push(`QuantumPipeline (Engines 7-12) leans ${input.intelligence.action} vs ${input.side}.`);
    }
    if (input.intelligence.recentSweeps >= 3) {
      contextStructure -= 10;
      conflicts.push(`Choppy repeated sweeps (${input.intelligence.recentSweeps} recent sweeps).`);
    }
  }
  if (input.hybrid) {
    const sideView = input.hybrid.bySide?.[input.side];
    if (sideView?.decision === input.side) {
      contextStructure += 10;
    } else if (sideView && sideView.decision === 'NO_TRADE' && sideView.rejectionStage === 'STAGE2_INDICATORS') {
      contextStructure -= 14;
      conflicts.push(`Hybrid Stage 2 indicator evidence opposes (${sideView.rejectionReason ?? 'unanimous contradiction'}).`);
    }
  }
  if (input.quality) {
    if (input.quality.grade === 'GOOD') contextStructure += 6;
    else if (input.quality.grade === 'POOR') {
      contextStructure -= 12;
      conflicts.push(`Market quality graded POOR (${input.quality.regime}).`);
    }
  }
  contextStructure = clamp(contextStructure, 15, 98);

  // 5. Historical Context (HSIE — strictly non-blocking when sparse/absent)
  let historicalContext = 50; // exact neutral baseline
  if (input.hsie) {
    if (input.hsie.status === 'STRONG_MATCHES' && input.hsie.winRatePct !== null) {
      const edge = input.hsie.winRatePct - input.hsie.breakevenWinRatePct;
      historicalContext = clamp(Math.round(55 + edge * 1.4), 25, 95);
      observations.push(
        `HSIE strong empirical sample (${input.hsie.similarSetups} matches, ${input.hsie.winRatePct}% WR vs ${input.hsie.breakevenWinRatePct}% BE).`
      );
      if (edge < -8) {
        conflicts.push(`HSIE shows historical underperformance (${input.hsie.winRatePct}% WR < ${input.hsie.breakevenWinRatePct}% BE over ${input.hsie.similarSetups} matches).`);
      }
    } else if (input.hsie.status === 'LIMITED_EVIDENCE') {
      observations.push(`HSIE limited sample (${input.hsie.similarSetups} match${input.hsie.similarSetups === 1 ? '' : 'es'}) — held neutral.`);
    } else {
      observations.push('HSIE found no close historical match — held strictly neutral (never blocks trade).');
    }
  }

  // Weighted quality score (higher = safer setup; falseMoveRisk = 100 - weightedQuality)
  const weightedQuality =
    sweepAnatomy * 0.25 +
    rejectionQuality * 0.25 +
    momentumExhaustion * 0.22 +
    contextStructure * 0.20 +
    historicalContext * 0.08;

  const falseMoveRiskScore = clamp(round1(100 - weightedQuality), 5, 95);
  const recommendation: QsiRecommendation =
    falseMoveRiskScore >= 76 && conflicts.length >= 2
      ? 'VETO'
      : falseMoveRiskScore >= 52 || conflicts.length >= 2
      ? 'CAUTION'
      : 'PASS';

  // In 'shadow' mode QSI NEVER blocks execution; in 'veto' mode only extreme false-move danger vetoes.
  const allow = mode === 'shadow' ? true : recommendation !== 'VETO';
  const confidenceAdjustment =
    recommendation === 'PASS' && weightedQuality >= 74 ? 5 : recommendation === 'VETO' ? -15 : recommendation === 'CAUTION' ? -5 : 0;

  const summary =
    `QSI (${mode.toUpperCase()}): ${recommendation} · False-move risk ${falseMoveRiskScore}/100 · ` +
    `${participation.size} engine layer(s) active` +
    (conflicts.length ? ` · Caution: ${conflicts[0]}` : ' · Clean structural alignment');

  return {
    mode,
    recommendation,
    allow,
    falseMoveRiskScore,
    confidenceAdjustment,
    componentScores: {
      sweepAnatomy: Math.round(sweepAnatomy),
      rejectionQuality: Math.round(rejectionQuality),
      momentumExhaustion: Math.round(momentumExhaustion),
      contextStructure: Math.round(contextStructure),
      historicalContext: Math.round(historicalContext),
    },
    engineParticipation: [...participation],
    observations,
    conflicts,
    summary,
  };
}

export function qsiPromptSection(
  qsi: QsiAssessment | null | undefined,
  intelligence?: QsiInput['intelligence']
): string {
  if (!qsi) return 'QUANTUM SWEEP INTELLIGENCE (QSI): not evaluated.';
  return [
    'QUANTUM SWEEP INTELLIGENCE (QSI) & QUANTUM PIPELINE (unified multi-engine context across all active engines):',
    JSON.stringify({
      mode: qsi.mode,
      recommendation: qsi.recommendation,
      falseMoveRiskScore: qsi.falseMoveRiskScore,
      componentScores: qsi.componentScores,
      engineParticipation: qsi.engineParticipation,
      quantumPipeline: intelligence ?? null,
      observations: qsi.observations,
      conflicts: qsi.conflicts,
      summary: qsi.summary,
    }, null, 1),
  ].join('\n');
}
