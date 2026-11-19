// PATTERN VALIDITY: "is the sweep the engine reported genuine?", decided by plain OHLC arithmetic.
//
// This module is the ONLY place that decides pattern validity. The AI never does:
//   - the rules below are exactly the conditions of the original strategy engines (wick penetration, candle direction, close location),
//   - they are recomputed here from the supplied candles, independently of the engine that raised the setup,
//   - Engines 5 and 6 are imported READ-ONLY (Engine 6's thresholds are re-run through its own function; Engine 5's rules are re-derived).
//
// Engulfing, momentum strength, choppiness and "probability" are NOT pattern rules and must never appear in this list.
import { validOhlc } from './candleMath';
import { detectMomentumSignal } from './momentumEngine';
import { findLsccSweep } from './lscc';
import { analyzeStructureSweep } from './structureSweep';
import { computeIndicatorSeries, evaluateIndicatorCrossover, findLookbackConfirmations } from './stochRsiSweep';

export interface Bar { time: number; open: number; high: number; low: number; close: number }
export type Side = 'BUY' | 'SELL';
export type SweepEngineKey = 'sweep' | 'continuation' | 'momentum' | 'lscc' | 'structure_sweep' | 'stoch_rsi_sweep';

export interface RuleResult { id: string; engine: SweepEngineKey; pass: boolean; detail: string }
export type PatternStatus = 'VALID' | 'INVALID' | 'INSUFFICIENT_EVIDENCE' | 'NOT_APPLICABLE';

export interface PatternVerification {
  status: PatternStatus;
  /** which sweep-family engines the setup claims (indicator-only / candlestick-only setups claim none) */
  claimed: { engine: SweepEngineKey; side: Side }[];
  rules: RuleResult[];
  failedRules: string[];
  /** missing or inconsistent evidence (bad OHLC, wrong signal candle, too few candles...). These are NOT strategy-rule failures. */
  dataIssues: string[];
  signalCandleTime: number | null;
  sweptLevel: number | null;
  /** the only rule ids that may ever invalidate the pattern for this setup */
  allowedRuleIds: string[];
}

/** The conditions of the original strategy, in words. They are shown to the AI verbatim so it cannot invent others. */
export const RULE_TEXT: Record<string, string> = {
  SWEEP_PREV_DIRECTION: 'BUY: the previous candle is bearish (close < open). SELL: the previous candle is bullish (close > open).',
  SWEEP_CANDLE_DIRECTION: 'BUY: the signal candle is bullish. SELL: the signal candle is bearish.',
  SWEEP_WICK_PENETRATION: 'BUY: signal.low is STRICTLY below previous.low. SELL: signal.high is STRICTLY above previous.high. Equal = only a touch = not a sweep.',
  SWEEP_CLOSE_LOCATION: 'BUY: the signal candle body (open and close) stays at or above previous.low. SELL: body stays at or below previous.high. Only the wick goes through the level.',
  CONT_P_DIRECTION: 'Engine 5, candle P (swept): bullish for SELL, bearish for BUY.',
  CONT_A_DIRECTION: 'Engine 5, candle A (sweeper): bearish for SELL, bullish for BUY.',
  CONT_A_WICK_PENETRATION: 'Engine 5: A.high > P.high strictly (SELL) / A.low < P.low strictly (BUY).',
  CONT_A_CLOSE_INSIDE_P_BODY: 'Engine 5: A.close lies inside the real body of P.',
  CONT_A_OPEN_NOT_BEYOND: 'Engine 5 (wick-only sweep): A.open does not open beyond the swept level.',
  CONT_B_DIRECTION: 'Engine 5: B closes in the trade direction (bearish for SELL, bullish for BUY).',
  CONT_C_DIRECTION: 'Engine 5: C closes in the trade direction (bearish for SELL, bullish for BUY).',
  CONT_CONSECUTIVE: 'Engine 5: P, A, B, C are consecutive candles (equal time spacing).',
  MOM_SAME_DIRECTION: 'Engine 6: the last three candles all close in the trade direction.',
  LSCC_LIQUIDITY_LEVEL: 'LSCC: the candle before the confirmation candle (the sweep candle) swept an ESTABLISHED liquidity level: a swing low below price (BUY) / swing high above price (SELL) that no earlier candle had traded through.',
  LSCC_WICK_PENETRATION: 'LSCC: the sweep candle low is STRICTLY below the level (BUY) / its high STRICTLY above it (SELL).',
  LSCC_BODY_NOT_BREAKOUT: 'LSCC: the sweep candle body (open and close) stays at or above the level (BUY) / at or below it (SELL). A body through the level is a breakout, not a sweep.',
  LSCC_CLOSE_BACK_INSIDE: 'LSCC: the sweep candle closes back above the level (BUY) / below the level (SELL).',
  LSCC_CONFIRM_DIRECTION: 'LSCC: the confirmation candle (the signal candle) is a separate candle after the sweep candle and is bullish (BUY) / bearish (SELL).',
  LSCC_CONFIRM_CLOSE_BEYOND: 'LSCC: the confirmation candle closes ABOVE the sweep candle high (BUY) / BELOW the sweep candle low (SELL).',
  LSCC_CONSECUTIVE: 'LSCC: the sweep candle and the confirmation candle are consecutive candles.',
  MOM_BODY_DOMINANCE: "Engine 6: the engine's own body-dominance thresholds are met (re-run with the engine's own function).",
  STRUCT_BIAS_ESTABLISHED: 'Structure Sweep: confirmed major Swing CHoCH/MSS or BOS directional bias must exist in the trade direction before the sweep.',
  STRUCT_BIAS_NOT_INVALIDATED: 'Structure Sweep: active directional bias must remain valid and not invalidated by an opposing major CHoCH/MSS.',
  STRUCT_PULLBACK_COLOUR: 'Structure Sweep: BUY requires a bearish/red pullback candle immediately before the sweep candle; SELL requires a bullish/green pullback candle.',
  STRUCT_SWEEP_DIRECTION: 'Structure Sweep: BUY requires a bullish/green sweep candle; SELL requires a bearish/red sweep candle.',
  STRUCT_WICK_PENETRATION: 'Structure Sweep: BUY sweep low strictly below pullback low; SELL sweep high strictly above pullback high.',
  STRUCT_CLOSE_RECOVERY: 'Structure Sweep: BUY sweep candle closes strictly above pullback low; SELL closes strictly below pullback high.',
  IND_STOCH_CROSS_ZONE: 'Stoch+RSI+Confirm: BUY requires Stochastic(14,3,3) %K crossing up from <=20; SELL requires %K crossing down from >=80.',
  IND_RSI_CROSS_LEVEL: 'Stoch+RSI+Confirm: BUY requires RSI(14) crossing up from <=30 or through 50; SELL requires RSI crossing down from >=70 or through 50.',
  IND_LOOKBACK_CANDLE_CONFIRM: 'Stoch+RSI+Confirm: recent closed candles (lookback window) must contain an aligned Wick Sweep or Candlestick Pattern confirming the indicator direction.',
};

const WINDOW: Record<SweepEngineKey, number> = { sweep: 2, continuation: 4, momentum: 3, lscc: 12, structure_sweep: 15, stoch_rsi_sweep: 17 };

export interface EngineClaims {
  side: Side | null;
  sweep?: { side: Side } | null;
  continuation?: { side: Side } | null;
  momentum?: { side: Side } | null;
  lscc?: { side: Side } | null;
  structure_sweep?: { side: Side } | null;
  stoch_rsi_sweep?: { side: Side } | null;
}

export function claimedEngines(e: EngineClaims): { engine: SweepEngineKey; side: Side }[] {
  const out: { engine: SweepEngineKey; side: Side }[] = [];
  if (e.sweep) out.push({ engine: 'sweep', side: e.sweep.side });
  if (e.continuation) out.push({ engine: 'continuation', side: e.continuation.side });
  if (e.momentum) out.push({ engine: 'momentum', side: e.momentum.side });
  if (e.lscc) out.push({ engine: 'lscc', side: e.lscc.side });
  if (e.structure_sweep) out.push({ engine: 'structure_sweep', side: e.structure_sweep.side });
  if (e.stoch_rsi_sweep) out.push({ engine: 'stoch_rsi_sweep', side: e.stoch_rsi_sweep.side });
  return out;
}

const f = (x: number) => String(+x.toPrecision(10));
const rule = (engine: SweepEngineKey, id: string, pass: boolean, detail: string): RuleResult => ({ id, engine, pass, detail });

function wickSweepRules(cs: Bar[], side: Side): RuleResult[] {
  const sell = side === 'SELL';
  const cur = cs[cs.length - 1], prev = cs[cs.length - 2];
  const bodyLo = Math.min(cur.open, cur.close), bodyHi = Math.max(cur.open, cur.close);
  return [
    rule('sweep', 'SWEEP_PREV_DIRECTION', sell ? prev.close > prev.open : prev.close < prev.open,
      `previous.close ${f(prev.close)} ${sell ? '>' : '<'} previous.open ${f(prev.open)} required`),
    rule('sweep', 'SWEEP_CANDLE_DIRECTION', sell ? cur.close < cur.open : cur.close > cur.open,
      `signal.close ${f(cur.close)} ${sell ? '<' : '>'} signal.open ${f(cur.open)} required`),
    rule('sweep', 'SWEEP_WICK_PENETRATION', sell ? cur.high > prev.high : cur.low < prev.low,
      sell ? `signal.high ${f(cur.high)} > previous.high ${f(prev.high)} required${cur.high === prev.high ? ' (equal = touch only)' : ''}`
        : `signal.low ${f(cur.low)} < previous.low ${f(prev.low)} required${cur.low === prev.low ? ' (equal = touch only)' : ''}`),
    rule('sweep', 'SWEEP_CLOSE_LOCATION', sell ? bodyHi <= prev.high : bodyLo >= prev.low,
      sell ? `body high ${f(bodyHi)} <= previous.high ${f(prev.high)} required` : `body low ${f(bodyLo)} >= previous.low ${f(prev.low)} required`),
  ];
}

function continuationRules(cs: Bar[], side: Side): RuleResult[] {
  const sell = side === 'SELL';
  const [P, A, B, C] = cs.slice(-4);
  const lo = Math.min(P.open, P.close), hi = Math.max(P.open, P.close);
  const gap = A.time - P.time;
  const consecutive = gap > 0 && B.time - A.time === gap && C.time - B.time === gap;
  const dir = (c: Bar) => (sell ? c.close < c.open : c.close > c.open);
  return [
    rule('continuation', 'CONT_P_DIRECTION', sell ? P.close > P.open : P.close < P.open, `P.close ${f(P.close)} vs P.open ${f(P.open)}`),
    rule('continuation', 'CONT_A_DIRECTION', dir(A), `A.close ${f(A.close)} vs A.open ${f(A.open)}`),
    rule('continuation', 'CONT_A_WICK_PENETRATION', sell ? A.high > P.high : A.low < P.low,
      sell ? `A.high ${f(A.high)} > P.high ${f(P.high)} required` : `A.low ${f(A.low)} < P.low ${f(P.low)} required`),
    rule('continuation', 'CONT_A_CLOSE_INSIDE_P_BODY', A.close >= lo && A.close <= hi, `${f(lo)} <= A.close ${f(A.close)} <= ${f(hi)} required`),
    rule('continuation', 'CONT_A_OPEN_NOT_BEYOND', sell ? A.open <= P.high : A.open >= P.low,
      sell ? `A.open ${f(A.open)} <= P.high ${f(P.high)} required` : `A.open ${f(A.open)} >= P.low ${f(P.low)} required`),
    rule('continuation', 'CONT_B_DIRECTION', dir(B), `B.close ${f(B.close)} vs B.open ${f(B.open)}`),
    rule('continuation', 'CONT_C_DIRECTION', dir(C), `C.close ${f(C.close)} vs C.open ${f(C.open)}`),
    rule('continuation', 'CONT_CONSECUTIVE', consecutive, `times ${[P, A, B, C].map((x) => x.time).join(', ')}`),
  ];
}

function momentumRules(cs: Bar[], side: Side): RuleResult[] {
  const sell = side === 'SELL';
  const last3 = cs.slice(-3);
  const same = last3.every((c) => (sell ? c.close < c.open : c.close > c.open));
  const s = detectMomentumSignal(cs, cs.length - 1);
  return [
    rule('momentum', 'MOM_SAME_DIRECTION', same, `last 3 closes vs opens: ${last3.map((c) => (c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'doji')).join(', ')}`),
    rule('momentum', 'MOM_BODY_DOMINANCE', !!s && s.side === side, s && s.side === side ? s.reasons.slice(0, 3).join('; ') : "Engine 6's own thresholds are not met on these candles"),
  ];
}

function lsccRules(cs: Bar[], side: Side): RuleResult[] {
  const n = cs.length, sell = side === 'SELL';
  const sw = cs[n - 2], cf = cs[n - 1], prev = cs[n - 3];
  const found = findLsccSweep(cs, n - 2);
  const hit = found && found.side === side ? found : null;
  const lv = hit ? hit.level : null;
  const none = 'no untouched liquidity level was swept by the sweep candle';
  const bodyLo = Math.min(sw.open, sw.close), bodyHi = Math.max(sw.open, sw.close);
  const gap = sw.time - prev.time;
  return [
    rule('lscc', 'LSCC_LIQUIDITY_LEVEL', !!hit, hit ? `level ${f(hit.level)} formed at ${hit.levelTime}, untouched until the sweep candle ${sw.time}` : none),
    rule('lscc', 'LSCC_WICK_PENETRATION', lv != null && (sell ? sw.high > lv : sw.low < lv), lv == null ? none : sell ? `sweep.high ${f(sw.high)} > level ${f(lv)} required` : `sweep.low ${f(sw.low)} < level ${f(lv)} required`),
    rule('lscc', 'LSCC_BODY_NOT_BREAKOUT', lv != null && (sell ? bodyHi <= lv : bodyLo >= lv), lv == null ? none : sell ? `body high ${f(bodyHi)} <= level ${f(lv)} required` : `body low ${f(bodyLo)} >= level ${f(lv)} required`),
    rule('lscc', 'LSCC_CLOSE_BACK_INSIDE', lv != null && (sell ? sw.close < lv : sw.close > lv), lv == null ? none : `sweep.close ${f(sw.close)} ${sell ? '<' : '>'} level ${f(lv)} required`),
    rule('lscc', 'LSCC_CONFIRM_DIRECTION', sell ? cf.close < cf.open : cf.close > cf.open, `confirmation.close ${f(cf.close)} ${sell ? '<' : '>'} confirmation.open ${f(cf.open)} required`),
    rule('lscc', 'LSCC_CONFIRM_CLOSE_BEYOND', sell ? cf.close < sw.low : cf.close > sw.high, sell ? `confirmation.close ${f(cf.close)} < sweep.low ${f(sw.low)} required` : `confirmation.close ${f(cf.close)} > sweep.high ${f(sw.high)} required`),
    rule('lscc', 'LSCC_CONSECUTIVE', gap > 0 && cf.time - sw.time === gap, `times ${prev.time}, ${sw.time}, ${cf.time}`),
  ];
}

function structureSweepRules(cs: Bar[], side: Side): RuleResult[] {
  const n = cs.length, sell = side === 'SELL';
  const prev = cs[n - 2], cur = cs[n - 1];
  const snap = analyzeStructureSweep(cs, n - 1, undefined, 45);
  const wantBias = sell ? 'BEARISH' : 'BULLISH';
  const hasBias = !!snap && snap.directionalBias === wantBias && !!snap.activeBias?.valid;
  const notInvalidated = !!snap && (!snap.lastInvalidation || snap.directionalBias === wantBias);
  return [
    rule(
      'structure_sweep',
      'STRUCT_BIAS_ESTABLISHED',
      hasBias,
      hasBias && snap?.activeBias
        ? `${snap.activeBias.direction} bias via ${snap.activeBias.eventType} break level ${f(snap.activeBias.breakLevel)}`
        : `no active ${wantBias} Swing CHoCH/MSS/BOS bias (state=${snap?.state ?? 'none'})`
    ),
    rule(
      'structure_sweep',
      'STRUCT_BIAS_NOT_INVALIDATED',
      notInvalidated,
      notInvalidated ? 'directional bias active and not invalidated by opposing CHoCH/MSS' : snap?.lastInvalidation?.reason ?? 'bias invalidated'
    ),
    rule(
      'structure_sweep',
      'STRUCT_PULLBACK_COLOUR',
      sell ? prev.close > prev.open : prev.close < prev.open,
      `pullback.close ${f(prev.close)} ${sell ? '>' : '<'} pullback.open ${f(prev.open)} required`
    ),
    rule(
      'structure_sweep',
      'STRUCT_SWEEP_DIRECTION',
      sell ? cur.close < cur.open : cur.close > cur.open,
      `sweep.close ${f(cur.close)} ${sell ? '<' : '>'} sweep.open ${f(cur.open)} required`
    ),
    rule(
      'structure_sweep',
      'STRUCT_WICK_PENETRATION',
      sell ? cur.high > prev.high : cur.low < prev.low,
      sell
        ? `sweep.high ${f(cur.high)} > pullback.high ${f(prev.high)} required`
        : `sweep.low ${f(cur.low)} < pullback.low ${f(prev.low)} required`
    ),
    rule(
      'structure_sweep',
      'STRUCT_CLOSE_RECOVERY',
      sell ? cur.close < prev.high : cur.close > prev.low,
      sell
        ? `sweep.close ${f(cur.close)} < pullback.high ${f(prev.high)} required`
        : `sweep.close ${f(cur.close)} > pullback.low ${f(prev.low)} required`
    ),
  ];
}

function stochRsiSweepRules(cs: Bar[], side: Side): RuleResult[] {
  const n = cs.length - 1;
  const series = computeIndicatorSeries(cs);
  const cross = evaluateIndicatorCrossover(series, n);
  const confs = findLookbackConfirmations(cs, n, side);
  const k = series.stochK[n], pk = series.stochK[Math.max(0, n - 1)];
  const r = series.rsi[n], pr = series.rsi[Math.max(0, n - 1)];
  const stochOk = !!cross && cross.side === side;
  const rsiOk = !!cross && cross.side === side;
  return [
    rule(
      'stoch_rsi_sweep',
      'IND_STOCH_CROSS_ZONE',
      stochOk,
      stochOk ? cross!.stochTrigger : `Stoch %K ${pk.toFixed(1)} -> ${k.toFixed(1)} does not confirm ${side} crossover from ${side === 'BUY' ? '<=20' : '>=80'}`
    ),
    rule(
      'stoch_rsi_sweep',
      'IND_RSI_CROSS_LEVEL',
      rsiOk,
      rsiOk ? cross!.rsiTrigger : `RSI(14) ${pr.toFixed(1)} -> ${r.toFixed(1)} does not confirm ${side} cross from ${side === 'BUY' ? '<=30/50' : '>=70/50'}`
    ),
    rule(
      'stoch_rsi_sweep',
      'IND_LOOKBACK_CANDLE_CONFIRM',
      confs.length > 0,
      confs.length > 0 ? `Lookback confirmations: ${confs.map((c) => c.label).slice(0, 3).join(', ')}` : `No aligned ${side} wick sweep or candlestick pattern in lookback candles`
    ),
  ];
}

/**
 * Recomputes the pattern the engines claimed. `closed` = closed candles only, oldest first, the last one is the signal candle.
 * `expectedSignalTime` = open time of the candle the signal belongs to (the same value the AI request and the screenshot carry).
 */
export function verifyPattern(claims: EngineClaims, closed: Bar[], expectedSignalTime: number): PatternVerification {
  const claimed = claimedEngines(claims);
  const dataIssues: string[] = [];
  const last = closed[closed.length - 1];
  const out = (status: PatternStatus, rules: RuleResult[], sweptLevel: number | null): PatternVerification => ({
    status, claimed, rules, failedRules: rules.filter((r) => !r.pass).map((r) => r.id), dataIssues,
    signalCandleTime: last ? last.time : null, sweptLevel, allowedRuleIds: rules.map((r) => r.id),
  });

  if (!last) { dataIssues.push('NO_CANDLES'); return out('INSUFFICIENT_EVIDENCE', [], null); }
  if (last.time !== expectedSignalTime) dataIssues.push(`SIGNAL_CANDLE_MISMATCH: last closed candle ${last.time}, signal says ${expectedSignalTime}`);
  const tail = closed.slice(-20);
  for (let k = 1; k < tail.length; k++) if (!(tail[k].time > tail[k - 1].time)) { dataIssues.push(`NON_MONOTONIC_TIMES at ${tail[k].time}`); break; }
  const need = Math.max(2, ...claimed.map((c) => WINDOW[c.engine]));
  if (closed.length < need) dataIssues.push(`NOT_ENOUGH_CANDLES: ${closed.length} < ${need}`);
  else for (const c of closed.slice(-need)) if (!validOhlc(c)) { dataIssues.push(`INVALID_OHLC at ${c.time}`); break; }

  if (!claimed.length) return out(dataIssues.length ? 'INSUFFICIENT_EVIDENCE' : 'NOT_APPLICABLE', [], null);
  if (dataIssues.length) return out('INSUFFICIENT_EVIDENCE', [], null);

  const rules: RuleResult[] = [];
  let level: number | null = null;
  for (const c of claimed) {
    if (c.engine === 'sweep') { rules.push(...wickSweepRules(closed, c.side)); level ??= c.side === 'SELL' ? closed[closed.length - 2].high : closed[closed.length - 2].low; }
    else if (c.engine === 'continuation') { rules.push(...continuationRules(closed, c.side)); level ??= c.side === 'SELL' ? closed[closed.length - 4].high : closed[closed.length - 4].low; }
    else if (c.engine === 'lscc') { rules.push(...lsccRules(closed.slice(-60), c.side)); level ??= findLsccSweep(closed.slice(-60), closed.slice(-60).length - 2)?.level ?? null; }
    else if (c.engine === 'structure_sweep') {
      const warmed = structureSweepRules(closed.slice(-300), c.side);
      const agentWin = closed.length > 45 ? structureSweepRules(closed.slice(-45), c.side) : warmed;
      const chosen = warmed.every((r) => r.pass) ? warmed : agentWin.every((r) => r.pass) ? agentWin : structureSweepRules(closed.slice(-60), c.side);
      rules.push(...chosen);
      level ??= c.side === 'SELL' ? closed[closed.length - 2].high : closed[closed.length - 2].low;
    }
    else if (c.engine === 'stoch_rsi_sweep') {
      const subWarmed = closed.slice(-300);
      const rWarmed = stochRsiSweepRules(subWarmed, c.side);
      const subAgent = closed.length > 45 ? closed.slice(-45) : subWarmed;
      const rAgent = subAgent === subWarmed ? rWarmed : stochRsiSweepRules(subAgent, c.side);
      const sub60 = closed.length > 60 ? closed.slice(-60) : subWarmed;
      const r60 = sub60 === subWarmed ? rWarmed : stochRsiSweepRules(sub60, c.side);
      const [chosenRules, chosenSub] = rWarmed.every((r) => r.pass)
        ? [rWarmed, subWarmed]
        : rAgent.every((r) => r.pass)
          ? [rAgent, subAgent]
          : r60.every((r) => r.pass)
            ? [r60, sub60]
            : [rWarmed, subWarmed];
      rules.push(...chosenRules);
      level ??= findLookbackConfirmations(chosenSub, chosenSub.length - 1, c.side)[0]?.level ?? null;
    }
    else rules.push(...momentumRules(closed.slice(-300), c.side));
  }
  const failed = rules.some((r) => !r.pass);
  return out(failed ? 'INVALID' : 'VALID', rules, level);
}
