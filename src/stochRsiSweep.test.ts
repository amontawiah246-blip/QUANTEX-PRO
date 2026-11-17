import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeIndicatorSeries,
  detectStochRsiSweepSignal,
  evaluateIndicatorCrossover,
  findLookbackConfirmations,
  OhlcBar,
  STOCH_RSI_DEFAULTS,
} from './stochRsiSweep';
import { evaluateEngines } from './engineEvaluator';
import { verifyPattern } from './patternVerification';
import { renderSignalSvg } from './screenshot';
import { runBacktest, stochRsiSweepStrategy } from './engineBacktest';

function makeBar(time: number, open: number, close: number, lowOffset = 0.0005, highOffset = 0.0005): OhlcBar {
  const lo = Math.min(open, close) - lowOffset;
  const hi = Math.max(open, close) + highOffset;
  return { time, open, high: hi, low: lo, close };
}

test('Slow Stochastic (14,3,3) matches SMA smoothed %K and %D formulas and Wilder RSI(14)', () => {
  const candles: OhlcBar[] = [];
  for (let i = 0; i < 30; i++) {
    const close = 100 + Math.sin(i * 0.45) * 4 + (i > 20 ? (i - 20) * 0.35 : 0);
    candles.push({
      time: 1_700_000_000 + i * 60,
      open: close - 0.3,
      high: close + 0.9,
      low: close - 0.9,
      close,
    });
  }
  const s = computeIndicatorSeries(candles);
  const idx = candles.length - 1;
  // Manual check of rawK -> 3-bar SMA for %K -> 3-bar SMA for %D
  const expK = (s.rawK[idx] + s.rawK[idx - 1] + s.rawK[idx - 2]) / 3;
  assert.ok(Math.abs(s.stochK[idx] - expK) < 1e-9, `expected %K=${expK}, got ${s.stochK[idx]}`);
  const expD = (s.stochK[idx] + s.stochK[idx - 1] + s.stochK[idx - 2]) / 3;
  assert.ok(Math.abs(s.stochD[idx] - expD) < 1e-9, `expected %D=${expD}, got ${s.stochD[idx]}`);
  assert.ok(s.rsi[idx] >= 0 && s.rsi[idx] <= 100);
});

test('BUY signal triggers when Stoch(14,3,3) <=20 & RSI(14) <=30/50 cross up with lookback bullish wick sweep', () => {
  const candles: OhlcBar[] = [];
  let p = 1.2000;
  // Flat baseline then steady selloff driving Stoch <= 20 and RSI <= 30
  for (let i = 0; i < 12; i++) {
    candles.push(makeBar(1_700_000_000 + i * 60, p, p + (i % 2 === 0 ? 0.0002 : -0.0002), 0.0003, 0.0003));
  }
  for (let i = 12; i < 28; i++) {
    const next = p - 0.0012;
    candles.push(makeBar(1_700_000_000 + i * 60, p, next, 0.0003, 0.0003));
    p = next;
  }
  // Lookback bar: classic bullish wick sweep (sweeps previous low, closes back above it)
  const prevLow = candles[candles.length - 1].low;
  const t28 = 1_700_000_000 + 28 * 60;
  candles.push({
    time: t28,
    open: prevLow + 0.0003,
    high: prevLow + 0.0020,
    low: prevLow - 0.0014,
    close: prevLow + 0.0016,
  });
  // Follow-through bullish closes pushing %K up across %D / 20 and RSI crossing up
  let base = prevLow + 0.0016;
  let signalIdx = -1;
  for (let k = 1; k <= 5; k++) {
    const next = base + 0.0018;
    candles.push(makeBar(t28 + k * 60, base, next, 0.0002, 0.0004));
    base = next;
    const hit = detectStochRsiSweepSignal(candles, candles.length - 1);
    if (hit && hit.side === 'BUY') {
      signalIdx = candles.length - 1;
      break;
    }
  }
  assert.ok(signalIdx >= 29, 'Expected a BUY Stoch+RSI+Confirm setup after oversold reversal + wick sweep');
  const sig = detectStochRsiSweepSignal(candles, signalIdx)!;
  assert.equal(sig.side, 'BUY');
  assert.ok(sig.confirmations.length > 0);
  assert.ok(sig.confidenceScore >= 76);
});

test('SELL signal triggers when Stoch(14,3,3) crosses down from >=80 1-3 bars prior and RSI crosses down across 50 (screenshot pattern)', () => {
  const candles: OhlcBar[] = [];
  let p = 1.1270;
  // Soft baseline + pull down so RSI starts below 50, then sharp push up where Stoch saturates >= 80 while RSI hovers ~52-60
  for (let i = 0; i < 14; i++) {
    const next = p - (i >= 8 ? 0.0007 : 0.0001);
    candles.push(makeBar(1_700_001_000 + i * 60, p, next, 0.0003, 0.0003));
    p = next;
  }
  for (let i = 14; i < 23; i++) {
    const next = p + 0.0006;
    candles.push(makeBar(1_700_001_000 + i * 60, p, next, 0.0002, 0.0002));
    p = next;
  }
  // Bearish wick sweep at top (high above prior high, closes back below it)
  const prevHigh = candles[candles.length - 1].high;
  const tTop = 1_700_001_000 + 23 * 60;
  candles.push({
    time: tTop,
    open: prevHigh - 0.0002,
    high: prevHigh + 0.0012,
    low: prevHigh - 0.0011,
    close: prevHigh - 0.0009,
  });
  // Gradual roll-over bars so Stoch crosses down from >= 80 first, then RSI crosses below 50 within alignWindow
  let cur = prevHigh - 0.0009;
  let foundSell = null as ReturnType<typeof detectStochRsiSweepSignal>;
  for (let k = 1; k <= 6; k++) {
    const next = cur - (k <= 2 ? 0.0007 : 0.0014);
    candles.push(makeBar(tTop + k * 60, cur, next, 0.0002, 0.0002));
    cur = next;
    const hit = detectStochRsiSweepSignal(candles, candles.length - 1);
    if (hit && hit.side === 'SELL') {
      foundSell = hit;
      break;
    }
  }
  assert.ok(foundSell, 'Expected a SELL Stoch+RSI+Confirm setup matching the overbought Stoch -> RSI 50 cross pattern');
  assert.equal(foundSell.side, 'SELL');
  assert.ok(foundSell.confirmations.some((c) => c.kind === 'wick_sweep' || c.kind === 'bearish_rejection'));
});

test('Rejects crossover when lookback window has NO sweep or candlestick reversal confirmation', () => {
  const candles: OhlcBar[] = [];
  let p = 1.1500;
  // Selloff ending with a large red bar (body 0.0012), so subsequent small green bars never engulf it
  for (let i = 0; i < 20; i++) {
    const drop = i === 19 ? 0.0014 : 0.0007;
    const next = p - drop;
    candles.push({ time: 1_700_002_000 + i * 60, open: p, high: p + 0.0002, low: next - 0.0002, close: next });
    p = next;
  }
  // Small gradual bullish bars with higher lows and balanced wicks (no sweep, no hammer, no engulfing)
  let hitCrossWithoutConfirm = false;
  for (let k = 0; k < 10; k++) {
    const next = p + 0.0005;
    candles.push({
      time: 1_700_002_000 + (20 + k) * 60,
      open: p,
      high: next + 0.0002,
      low: p - 0.0001,
      close: next,
    });
    p = next;
    const idx = candles.length - 1;
    const series = computeIndicatorSeries(candles);
    const cross = evaluateIndicatorCrossover(series, idx);
    if (cross && cross.side === 'BUY') {
      const confs = findLookbackConfirmations(candles, idx, 'BUY', STOCH_RSI_DEFAULTS.lookbackCandles);
      if (confs.length === 0) {
        hitCrossWithoutConfirm = true;
        assert.equal(detectStochRsiSweepSignal(candles, idx, STOCH_RSI_DEFAULTS, series), null);
      }
    }
  }
  assert.ok(hitCrossWithoutConfirm, 'Expected at least one plain crossover without lookback confirmation to be rejected');
});

test('Strict causality: future candles beyond bar i never change indicators or signal at bar i', () => {
  const candles: OhlcBar[] = [];
  let p = 2000;
  for (let i = 0; i < 40; i++) {
    const delta = Math.sin(i * 0.5) * 4;
    candles.push(makeBar(1_700_003_000 + i * 60, p, p + delta, 1.5, 1.5));
    p += delta;
  }
  const probe = 30;
  const sPrefix = computeIndicatorSeries(candles.slice(0, probe + 1));
  const mutated = candles.map((c, idx) =>
    idx > probe ? { ...c, high: c.high + 500, low: c.low - 500, close: c.close + 300 } : c,
  );
  const sFutureMutated = computeIndicatorSeries(mutated);
  assert.equal(sPrefix.stochK[probe], sFutureMutated.stochK[probe]);
  assert.equal(sPrefix.stochD[probe], sFutureMutated.stochD[probe]);
  assert.equal(sPrefix.rsi[probe], sFutureMutated.rsi[probe]);
  assert.deepEqual(
    detectStochRsiSweepSignal(candles.slice(0, probe + 1), probe),
    detectStochRsiSweepSignal(mutated, probe),
  );
});

test('verifyPattern, evaluateEngines, and renderSignalSvg render Stochastic Oscillator 14 3 3 and RSI 14 accurately', () => {
  const candles: OhlcBar[] = [];
  let p = 1.2100;
  for (let i = 0; i < 12; i++) candles.push(makeBar(1_700_004_000 + i * 60, p, p + (i % 2 ? 0.0002 : -0.0002)));
  for (let i = 12; i < 28; i++) {
    const next = p - 0.0012;
    candles.push(makeBar(1_700_004_000 + i * 60, p, next));
    p = next;
  }
  const prevLow = candles[candles.length - 1].low;
  const t28 = 1_700_004_000 + 28 * 60;
  candles.push({ time: t28, open: prevLow + 0.0003, high: prevLow + 0.0020, low: prevLow - 0.0014, close: prevLow + 0.0016 });
  let base = prevLow + 0.0016;
  let triggerLen = 0;
  for (let k = 1; k <= 5; k++) {
    const next = base + 0.0018;
    candles.push(makeBar(t28 + k * 60, base, next, 0.0002, 0.0004));
    base = next;
    const hit = detectStochRsiSweepSignal(candles, candles.length - 1);
    if (hit && hit.side === 'BUY') {
      triggerLen = candles.length;
      break;
    }
  }
  assert.ok(triggerLen > 0);
  const sub = candles.slice(0, triggerLen);
  const lastTime = sub[sub.length - 1].time;
  const ver = verifyPattern({ side: 'BUY', stoch_rsi_sweep: { side: 'BUY' } }, sub, lastTime);
  assert.equal(ver.status, 'VALID');
  assert.equal(ver.failedRules.length, 0);

  const svg = renderSignalSvg(sub, 'BUY', ver, 'Gold / USD (XAUUSD)', 'frxXAUUSD', 60);
  assert.ok(svg.includes('Stochastic Oscillator 14 3 3'), 'SVG should include Stochastic Oscillator 14 3 3 panel');
  assert.ok(svg.includes('RSI 14'), 'SVG should include RSI 14 panel');
  assert.ok(svg.includes('#3b82f6') && svg.includes('#f97316'), 'SVG should use blue %K and solid orange %D');
  assert.ok(svg.includes('#a3e635'), 'SVG should use lime RSI line');

  const eng = evaluateEngines(sub, 60, 1, 'frxXAUUSD');
  assert.ok(eng.stochRsiSweep, 'evaluateEngines should populate stochRsiSweep when setup triggers');
});

test('stochRsiSweepStrategy runs deterministically on 300-bar Gold M1 -> 4m backtest', () => {
  const candles: OhlcBar[] = [];
  let price = 2350;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 300; i++) {
    const wave = Math.sin(i * 0.25) * 2.2 + (rand() - 0.5) * 1.4;
    const open = price;
    const close = open + wave;
    const wickLo = Math.abs(rand()) * 2.4;
    const wickHi = Math.abs(rand()) * 2.4;
    candles.push({
      time: 1_700_100_000 + i * 60,
      open,
      high: Math.max(open, close) + wickHi,
      low: Math.min(open, close) - wickLo,
      close,
    });
    price = close;
  }

  const strat = stochRsiSweepStrategy();
  const r1 = runBacktest([{ symbol: 'frxXAUUSD', candles }], {
    tf: 60,
    expiries: [240],
    strategies: [strat],
  });
  const r2 = runBacktest([{ symbol: 'frxXAUUSD', candles }], {
    tf: 60,
    expiries: [240],
    strategies: [strat],
  });
  assert.deepEqual(r1.trades, r2.trades);
  assert.equal(r1.report.strategies.length, 1);
  assert.equal(r1.report.strategies[0].id, 'stoch_rsi_sweep');
});

test('SELL aligns across 5-8 bar continuous Stoch>=80->%K<%D drop and RSI 50 cross matching screenshots', () => {
  const n = 35;
  const stochK = new Array<number>(n).fill(50);
  const stochD = new Array<number>(n).fill(50);
  const rawK = new Array<number>(n).fill(50);
  const rsi = new Array<number>(n).fill(62);

  // Bar 23: Stoch crosses down out of >=80 while %K < %D
  stochK[22] = 84; stochD[22] = 82;
  stochK[23] = 77; stochD[23] = 80;
  // Bars 24..30: uninterrupted %K < %D falling progression (7 bars lag, matching EUR/USD & AUD/NZD OTC screenshots)
  const kPath = [71, 65, 58, 51, 45, 38, 31];
  const dPath = [75, 70, 64, 58, 52, 46, 40];
  const rPath = [60, 58.5, 56.8, 55.2, 53.6, 51.4, 48.2];
  for (let offset = 0; offset < kPath.length; offset++) {
    const idx = 24 + offset;
    stochK[idx] = kPath[offset];
    stochD[idx] = dPath[offset];
    rsi[idx] = rPath[offset];
  }

  const cross = evaluateIndicatorCrossover({ rsi, rawK, stochK, stochD }, 30);
  assert.ok(cross, 'Expected 7-bar continuous Stoch>=80 cross -> RSI 50 cross to align cleanly');
  assert.equal(cross.side, 'SELL');
});

test('Whipsaw between earlier Stoch cross and RSI cross breaks continuity and is rejected', () => {
  const n = 35;
  const stochK = new Array<number>(n).fill(50);
  const stochD = new Array<number>(n).fill(50);
  const rawK = new Array<number>(n).fill(50);
  const rsi = new Array<number>(n).fill(62);

  // Bar 23 crosses down from >=80
  stochK[22] = 83; stochD[22] = 81;
  stochK[23] = 78; stochD[23] = 80;
  // Drops cleanly to ~68, then bar 27 whipsaws back above %D well below 80 (invalidating continuity from bar 23)
  stochK[24] = 72; stochD[24] = 75;
  stochK[25] = 68; stochD[25] = 71;
  stochK[26] = 66; stochD[26] = 69;
  stochK[27] = 69; stochD[27] = 68;
  stochK[28] = 62; stochD[28] = 65;
  stochK[29] = 52; stochD[29] = 58;
  stochK[30] = 42; stochD[30] = 50;
  rsi[29] = 51.5;
  rsi[30] = 48.0;

  const cross = evaluateIndicatorCrossover({ rsi, rawK, stochK, stochD }, 30);
  assert.equal(cross, null, 'Whipsawed %K > %D bar in [j+1..i] must prevent pairing with stale overbought cross');
});

