export interface OhlcBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type StochRsiSide = 'BUY' | 'SELL';

export interface StochRsiParams {
  stochKPeriod: number;
  stochSmoothK: number;
  stochDPeriod: number;
  stochOversold: number;
  stochOverbought: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiMid: number;
  rsiOverbought: number;
  lookbackCandles: number;
  alignWindow: number;
}

export const STOCH_RSI_DEFAULTS: StochRsiParams = {
  stochKPeriod: 14,
  stochSmoothK: 3,
  stochDPeriod: 3,
  stochOversold: 20,
  stochOverbought: 80,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiMid: 50,
  rsiOverbought: 70,
  lookbackCandles: 5,
  alignWindow: 8,
};

export interface IndicatorSeriesSnapshot {
  rsi: number[];
  rawK: number[];
  stochK: number[];
  stochD: number[];
}

export interface LookbackConfirmation {
  kind:
    | 'wick_sweep'
    | 'hammer_pinbar'
    | 'shooting_star'
    | 'bullish_engulfing'
    | 'bearish_engulfing'
    | 'bullish_rejection'
    | 'bearish_rejection';
  index: number;
  time: number;
  label: string;
  level: number;
}

export interface IndicatorCrossoverResult {
  side: StochRsiSide;
  stochTrigger: string;
  rsiTrigger: string;
  stochK: number;
  stochD: number;
  prevStochK: number;
  prevStochD: number;
  rsi: number;
  prevRsi: number;
}

export interface StochRsiSweepSignal {
  side: StochRsiSide;
  index: number;
  time: number;
  entryReference: number;
  sweptLevel: number;
  stochK: number;
  stochD: number;
  rsi: number;
  stochTrigger: string;
  rsiTrigger: string;
  confirmations: LookbackConfirmation[];
  confidenceScore: number;
  reasons: string[];
  trace: string[];
}

const EPS = 1e-12;

/**
 * Strictly causal Wilder's RSI(period) + Slow Stochastic Oscillator(14, 3, 3).
 * Element [i] depends ONLY on candles[0..i] (zero future-candle lookahead / zero repainting).
 */
export function computeIndicatorSeries(
  candles: readonly OhlcBar[],
  params: StochRsiParams = STOCH_RSI_DEFAULTS,
): IndicatorSeriesSnapshot {
  const n = candles.length;
  const rsi = new Array<number>(n).fill(50);
  const rawK = new Array<number>(n).fill(50);
  const stochK = new Array<number>(n).fill(50);
  const stochD = new Array<number>(n).fill(50);
  if (n === 0) return { rsi, rawK, stochK, stochD };

  // 1. Causal Wilder's RSI(14)
  const rPer = Math.max(2, params.rsiPeriod);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < n; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;

    if (i <= rPer) {
      avgGain += gain;
      avgLoss += loss;
      if (i === rPer) {
        avgGain /= rPer;
        avgLoss /= rPer;
        rsi[i] = avgLoss <= EPS ? (avgGain <= EPS ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
      } else {
        const gAvg = avgGain / i;
        const lAvg = avgLoss / i;
        rsi[i] = lAvg <= EPS ? (gAvg <= EPS ? 50 : 100) : 100 - 100 / (1 + gAvg / lAvg);
      }
    } else {
      avgGain = (avgGain * (rPer - 1) + gain) / rPer;
      avgLoss = (avgLoss * (rPer - 1) + loss) / rPer;
      rsi[i] = avgLoss <= EPS ? (avgGain <= EPS ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }

  // 2. Causal Slow Stochastic Oscillator (14, 3, 3):
  //    rawK = 100 * (C - LowestLow(14)) / (HighestHigh(14) - LowestLow(14))
  //    %K   = SMA(rawK, 3)
  //    %D   = SMA(%K, 3)
  const kPer = Math.max(2, params.stochKPeriod);
  const smoothK = Math.max(1, params.stochSmoothK);
  const dPer = Math.max(1, params.stochDPeriod);

  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - kPer + 1);
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = start; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    const span = hh - ll;
    rawK[i] = span <= EPS ? 50 : Math.max(0, Math.min(100, ((candles[i].close - ll) / span) * 100));

    const kStart = Math.max(0, i - smoothK + 1);
    let kSum = 0;
    for (let j = kStart; j <= i; j++) kSum += rawK[j];
    stochK[i] = kSum / (i - kStart + 1);

    const dStart = Math.max(0, i - dPer + 1);
    let dSum = 0;
    for (let j = dStart; j <= i; j++) dSum += stochK[j];
    stochD[i] = dSum / (i - dStart + 1);
  }

  return { rsi, rawK, stochK, stochD };
}

function stochBuyTriggerAt(
  stochK: readonly number[],
  stochD: readonly number[],
  j: number,
  params: StochRsiParams,
): string | null {
  if (j < 1) return null;
  const k = stochK[j], pk = stochK[j - 1];
  const d = stochD[j], pd = stochD[j - 1];
  const os = params.stochOversold;

  let recentMin = Math.min(k, pk, d, pd);
  for (let idx = Math.max(0, j - 3); idx <= j; idx++) {
    recentMin = Math.min(recentMin, stochK[idx], stochD[idx]);
  }

  // 1) %K crossed upward across the 20 line while moving up / above %D
  if (pk <= os && k > os && k >= d - 0.5) {
    return `Stoch(14,3,3) %K crossed up from <=${os} (${pk.toFixed(1)} -> ${k.toFixed(1)})`;
  }
  // 2) %K crossed above %D inside or immediately emerging from oversold (<=20)
  if (pk <= pd && k > d && k > pk && recentMin <= os + 2) {
    return `Stoch(14,3,3) %K crossed above %D from oversold ${recentMin.toFixed(1)} (${k.toFixed(1)} > ${d.toFixed(1)})`;
  }
  return null;
}

function stochSellTriggerAt(
  stochK: readonly number[],
  stochD: readonly number[],
  j: number,
  params: StochRsiParams,
): string | null {
  if (j < 1) return null;
  const k = stochK[j], pk = stochK[j - 1];
  const d = stochD[j], pd = stochD[j - 1];
  const ob = params.stochOverbought;

  let recentMax = Math.max(k, pk, d, pd);
  for (let idx = Math.max(0, j - 3); idx <= j; idx++) {
    recentMax = Math.max(recentMax, stochK[idx], stochD[idx]);
  }

  // 1) %K crossed downward across the 80 line while moving down / below %D
  if (pk >= ob && k < ob && k <= d + 0.5) {
    return `Stoch(14,3,3) %K crossed down from >=${ob} (${pk.toFixed(1)} -> ${k.toFixed(1)})`;
  }
  // 2) %K crossed below %D inside or immediately emerging from overbought (>=80)
  if (pk >= pd && k < d && k < pk && recentMax >= ob - 2) {
    return `Stoch(14,3,3) %K crossed below %D from overbought ${recentMax.toFixed(1)} (${k.toFixed(1)} < ${d.toFixed(1)})`;
  }
  return null;
}

function rsiBuyTriggerAt(rsi: readonly number[], j: number, params: StochRsiParams): string | null {
  if (j < 1) return null;
  const r = rsi[j], pr = rsi[j - 1];
  if (pr <= params.rsiOversold && r > params.rsiOversold) {
    return `RSI(14) crossed up from <=${params.rsiOversold} (${pr.toFixed(1)} -> ${r.toFixed(1)})`;
  }
  if (pr <= params.rsiMid && r > params.rsiMid) {
    return `RSI(14) crossed up above ${params.rsiMid} (${pr.toFixed(1)} -> ${r.toFixed(1)})`;
  }
  return null;
}

function rsiSellTriggerAt(rsi: readonly number[], j: number, params: StochRsiParams): string | null {
  if (j < 1) return null;
  const r = rsi[j], pr = rsi[j - 1];
  if (pr >= params.rsiOverbought && r < params.rsiOverbought) {
    return `RSI(14) crossed down from >=${params.rsiOverbought} (${pr.toFixed(1)} -> ${r.toFixed(1)})`;
  }
  if (pr >= params.rsiMid && r < params.rsiMid) {
    return `RSI(14) crossed down below ${params.rsiMid} (${pr.toFixed(1)} -> ${r.toFixed(1)})`;
  }
  return null;
}

/**
 * Evaluates Stochastic(14,3,3) + RSI(14) crossover alignment at closed bar `i`.
 * Either both cross on bar `i`, OR one crosses on bar `i` while the companion indicator
 * crossed in the same direction within `alignWindow` bars and remains actively aligned.
 */
export function evaluateIndicatorCrossover(
  series: IndicatorSeriesSnapshot,
  i: number,
  params: StochRsiParams = STOCH_RSI_DEFAULTS,
): IndicatorCrossoverResult | null {
  const minReady = Math.max(params.stochKPeriod + 2, params.rsiPeriod + 2);
  if (i < minReady || i >= series.stochK.length) return null;

  const { stochK, stochD, rsi } = series;
  const k = stochK[i], pk = stochK[i - 1];
  const d = stochD[i], pd = stochD[i - 1];
  const r = rsi[i], pr = rsi[i - 1];
  const win = Math.max(1, params.alignWindow);

  // --- BUY check
  const curStochBuy = stochBuyTriggerAt(stochK, stochD, i, params);
  const curRsiBuy = rsiBuyTriggerAt(rsi, i, params);
  const activeStochBuy = k > d && k > pk && k < params.stochOverbought - 2;
  const activeRsiBuy = r > pr && r > params.rsiOversold && r < params.rsiOverbought - 2;

  if ((curStochBuy || curRsiBuy) && activeStochBuy && activeRsiBuy) {
    let stochTrig = curStochBuy;
    let rsiTrig = curRsiBuy;
    if (!stochTrig) {
      for (let j = i - 1; j >= Math.max(1, i - win); j--) {
        const hit = stochBuyTriggerAt(stochK, stochD, j, params);
        if (hit) {
          let uninterrupted = true;
          for (let m = j + 1; m <= i; m++) {
            if (stochK[m] <= stochD[m]) {
              uninterrupted = false;
              break;
            }
          }
          if (uninterrupted) {
            stochTrig = `${hit} (${i - j}b ago, %K ${k.toFixed(1)} > %D ${d.toFixed(1)})`;
            break;
          }
        }
      }
    }
    if (!rsiTrig) {
      for (let j = i - 1; j >= Math.max(1, i - win); j--) {
        const hit = rsiBuyTriggerAt(rsi, j, params);
        if (hit) {
          const floor = rsi[j - 1] <= params.rsiMid && rsi[j] > params.rsiMid ? params.rsiMid : params.rsiOversold;
          let uninterrupted = true;
          for (let m = j; m <= i; m++) {
            if (rsi[m] <= floor) {
              uninterrupted = false;
              break;
            }
          }
          if (uninterrupted) {
            rsiTrig = `${hit} (${i - j}b ago, now ${r.toFixed(1)})`;
            break;
          }
        }
      }
    }
    if (stochTrig && rsiTrig) {
      return {
        side: 'BUY',
        stochTrigger: stochTrig,
        rsiTrigger: rsiTrig,
        stochK: k,
        stochD: d,
        prevStochK: pk,
        prevStochD: pd,
        rsi: r,
        prevRsi: pr,
      };
    }
  }

  // --- SELL check
  const curStochSell = stochSellTriggerAt(stochK, stochD, i, params);
  const curRsiSell = rsiSellTriggerAt(rsi, i, params);
  const activeStochSell = k < d && k < pk && k > params.stochOversold + 2;
  const activeRsiSell = r < pr && r < params.rsiOverbought && r > params.rsiOversold + 2;

  if ((curStochSell || curRsiSell) && activeStochSell && activeRsiSell) {
    let stochTrig = curStochSell;
    let rsiTrig = curRsiSell;
    if (!stochTrig) {
      for (let j = i - 1; j >= Math.max(1, i - win); j--) {
        const hit = stochSellTriggerAt(stochK, stochD, j, params);
        if (hit) {
          let uninterrupted = true;
          for (let m = j + 1; m <= i; m++) {
            if (stochK[m] >= stochD[m]) {
              uninterrupted = false;
              break;
            }
          }
          if (uninterrupted) {
            stochTrig = `${hit} (${i - j}b ago, %K ${k.toFixed(1)} < %D ${d.toFixed(1)})`;
            break;
          }
        }
      }
    }
    if (!rsiTrig) {
      for (let j = i - 1; j >= Math.max(1, i - win); j--) {
        const hit = rsiSellTriggerAt(rsi, j, params);
        if (hit) {
          const ceil = rsi[j - 1] >= params.rsiMid && rsi[j] < params.rsiMid ? params.rsiMid : params.rsiOverbought;
          let uninterrupted = true;
          for (let m = j; m <= i; m++) {
            if (rsi[m] >= ceil) {
              uninterrupted = false;
              break;
            }
          }
          if (uninterrupted) {
            rsiTrig = `${hit} (${i - j}b ago, now ${r.toFixed(1)})`;
            break;
          }
        }
      }
    }
    if (stochTrig && rsiTrig) {
      return {
        side: 'SELL',
        stochTrigger: stochTrig,
        rsiTrigger: rsiTrig,
        stochK: k,
        stochD: d,
        prevStochK: pk,
        prevStochD: pd,
        rsi: r,
        prevRsi: pr,
      };
    }
  }

  return null;
}

/**
 * Looks back across the last `lookbackCandles` closed candles `[i - lookback + 1 .. i]`
 * for aligned Wick Sweeps or Candlestick Reversal Patterns confirming `side`.
 */
export function findLookbackConfirmations(
  candles: readonly OhlcBar[],
  i: number,
  side: StochRsiSide,
  lookbackCandles = STOCH_RSI_DEFAULTS.lookbackCandles,
): LookbackConfirmation[] {
  const out: LookbackConfirmation[] = [];
  if (i < 1 || i >= candles.length) return out;
  const from = Math.max(1, i - Math.max(1, lookbackCandles) + 1);

  for (let idx = i; idx >= from; idx--) {
    const cur = candles[idx];
    const prev = candles[idx - 1];
    const range = Math.max(EPS, cur.high - cur.low);
    const body = Math.abs(cur.close - cur.open);
    const bodyLo = Math.min(cur.open, cur.close);
    const bodyHi = Math.max(cur.open, cur.close);
    const lowerWick = bodyLo - cur.low;
    const upperWick = cur.high - bodyHi;

    if (side === 'BUY') {
      // 1. Classic Wick Sweep (swept prior candle low and closed back above it)
      if (cur.low < prev.low && bodyLo >= prev.low && cur.close >= cur.open) {
        out.push({
          kind: 'wick_sweep',
          index: idx,
          time: cur.time,
          label: idx === i ? 'Bullish Wick Sweep (current bar)' : `Bullish Wick Sweep (-${i - idx}b)`,
          level: prev.low,
        });
      } else if (cur.low < prev.low && cur.close > prev.low && lowerWick >= body * 0.8) {
        out.push({
          kind: 'bullish_rejection',
          index: idx,
          time: cur.time,
          label: `Lower Wick Liquidity Rejection (-${i - idx}b)`,
          level: prev.low,
        });
      }

      // 2. Bullish Hammer / Pinbar
      if (lowerWick / range >= 0.55 && body / range <= 0.35 && upperWick / range <= 0.2) {
        out.push({
          kind: 'hammer_pinbar',
          index: idx,
          time: cur.time,
          label: `Bullish Hammer / Pinbar (-${i - idx}b)`,
          level: cur.low,
        });
      }

      // 3. Bullish Engulfing
      if (
        prev.close < prev.open &&
        cur.close > cur.open &&
        cur.close >= prev.open &&
        cur.open <= prev.close &&
        body >= Math.abs(prev.close - prev.open) * 0.95
      ) {
        out.push({
          kind: 'bullish_engulfing',
          index: idx,
          time: cur.time,
          label: `Bullish Engulfing (-${i - idx}b)`,
          level: Math.min(cur.low, prev.low),
        });
      }
    } else {
      // 1. Classic Bearish Wick Sweep (swept prior candle high and closed back below it)
      if (cur.high > prev.high && bodyHi <= prev.high && cur.close <= cur.open) {
        out.push({
          kind: 'wick_sweep',
          index: idx,
          time: cur.time,
          label: idx === i ? 'Bearish Wick Sweep (current bar)' : `Bearish Wick Sweep (-${i - idx}b)`,
          level: prev.high,
        });
      } else if (cur.high > prev.high && cur.close < prev.high && upperWick >= body * 0.8) {
        out.push({
          kind: 'bearish_rejection',
          index: idx,
          time: cur.time,
          label: `Upper Wick Liquidity Rejection (-${i - idx}b)`,
          level: prev.high,
        });
      }

      // 2. Bearish Shooting Star
      if (upperWick / range >= 0.55 && body / range <= 0.35 && lowerWick / range <= 0.2) {
        out.push({
          kind: 'shooting_star',
          index: idx,
          time: cur.time,
          label: `Bearish Shooting Star (-${i - idx}b)`,
          level: cur.high,
        });
      }

      // 3. Bearish Engulfing
      if (
        prev.close > prev.open &&
        cur.close < cur.open &&
        cur.close <= prev.open &&
        cur.open >= prev.close &&
        body >= Math.abs(prev.close - prev.open) * 0.95
      ) {
        out.push({
          kind: 'bearish_engulfing',
          index: idx,
          time: cur.time,
          label: `Bearish Engulfing (-${i - idx}b)`,
          level: Math.max(cur.high, prev.high),
        });
      }
    }
  }

  return out;
}

export function detectStochRsiSweepSignal(
  candles: readonly OhlcBar[],
  i: number = candles.length - 1,
  params: StochRsiParams = STOCH_RSI_DEFAULTS,
  precomputed?: IndicatorSeriesSnapshot,
): StochRsiSweepSignal | null {
  if (i < 16 || i >= candles.length) return null;
  const series = precomputed ?? computeIndicatorSeries(candles.slice(0, i + 1), params);
  const cross = evaluateIndicatorCrossover(series, i, params);
  if (!cross) return null;

  const cur = candles[i];
  const range = Math.max(EPS, cur.high - cur.low);
  const bodyRatio = Math.abs(cur.close - cur.open) / range;
  // Do not enter against a massive counter-direction solid candle at the trigger close
  if (cross.side === 'BUY' && cur.close < cur.open && bodyRatio > 0.65) return null;
  if (cross.side === 'SELL' && cur.close > cur.open && bodyRatio > 0.65) return null;

  const confirmations = findLookbackConfirmations(candles, i, cross.side, params.lookbackCandles);
  if (confirmations.length === 0) return null;

  const hasSweep = confirmations.some((c) => c.kind === 'wick_sweep' || c.kind === 'bullish_rejection' || c.kind === 'bearish_rejection');
  const confidenceScore = Math.min(95, 76 + (hasSweep ? 9 : 5) + Math.min(10, (confirmations.length - 1) * 5));
  const sweptLevel = confirmations[0].level;

  const reasons = [
    cross.stochTrigger,
    cross.rsiTrigger,
    `Confirmed by ${confirmations.map((c) => c.label).slice(0, 2).join(' + ')}`,
  ];

  const trace = [
    `stochK=${cross.stochK.toFixed(2)} (prev ${cross.prevStochK.toFixed(2)}) | stochD=${cross.stochD.toFixed(2)} (prev ${cross.prevStochD.toFixed(2)})`,
    `rsi=${cross.rsi.toFixed(2)} (prev ${cross.prevRsi.toFixed(2)})`,
    ...confirmations.map((c) => `confirm[${c.index}@${c.time}]: ${c.label} level=${c.level}`),
  ];

  return {
    side: cross.side,
    index: i,
    time: cur.time,
    entryReference: cur.close,
    sweptLevel,
    stochK: Number(cross.stochK.toFixed(2)),
    stochD: Number(cross.stochD.toFixed(2)),
    rsi: Number(cross.rsi.toFixed(2)),
    stochTrigger: cross.stochTrigger,
    rsiTrigger: cross.rsiTrigger,
    confirmations,
    confidenceScore,
    reasons,
    trace,
  };
}
