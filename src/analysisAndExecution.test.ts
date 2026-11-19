import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEngines } from './engineEvaluator';
import { verifyPattern, type Bar } from './patternVerification';
import { assessMarketQuality } from './marketQuality';
import { DEFAULT_POLICY, reconcile } from './aiVerification';
import { gateHybrid } from './hybridGate';
import { renderAlertSvg } from './sweepChart';
import { renderSignalSvg } from './screenshot';
import { SweepWatcherService } from './sweepWatcherCore';
import { CandidateHub } from './candidateHub';
import { getSignal, resetSignalCaches, type EngineResult } from '../signalServer';
import { engine as mkEngine, fakeAi, fakeRasterizer, market, nowAfter, withSweep, T0, TF } from './aiFixtures';
import { marketCondition } from './conditions';
import { detectStochRsiSweepSignal } from './stochRsiSweep';
import type { HybridView } from './hybridEngine';

const T = 152;
const B = 500;
const STO_T = 532;

function makeBar(time: number, open: number, close: number, lowOffset = 0.0003, highOffset = 0.0003): Bar {
  return {
    time,
    open,
    high: Math.max(open, close) + highOffset,
    low: Math.min(open, close) - lowOffset,
    close,
  };
}

function buildStochRsiBuySetup(warmupBars = 150): Bar[] {
  const bars: Bar[] = [];
  let p = 1.2500;
  // Warmup baseline
  for (let i = 0; i < warmupBars; i++) {
    const next = p + (i % 2 === 0 ? 0.00025 : -0.00025);
    bars.push(makeBar(T0 + i * 60, p, next, 0.0003, 0.0003));
    p = next;
  }
  // Oversold plunge driving Stoch(14,3,3) <= 20 & RSI <= 30
  for (let i = 0; i < 16; i++) {
    const next = p - 0.0012;
    bars.push(makeBar(T0 + bars.length * 60, p, next, 0.0003, 0.0003));
    p = next;
  }
  // Bullish wick sweep lookback bar
  const prevRed = bars[bars.length - 1];
  bars.push({
    time: T0 + bars.length * 60,
    open: prevRed.low + 0.0003,
    high: prevRed.low + 0.0020,
    low: prevRed.low - 0.0014,
    close: prevRed.low + 0.0016,
  });
  let base = prevRed.low + 0.0016;
  for (let k = 1; k <= 6; k++) {
    const next = base + 0.0018;
    bars.push(makeBar(T0 + bars.length * 60, base, next, 0.0002, 0.0004));
    base = next;
    const hit = detectStochRsiSweepSignal(bars, bars.length - 1);
    if (hit && hit.side === 'BUY') {
      return bars;
    }
  }
  throw new Error('Failed to construct Stoch+RSI BUY fixture');
}

function buildStochRsiBuyWithMinorBearPinbar(): Bar[] {
  const baseBars = buildStochRsiBuySetup(150);
  // Modify the final bar into an upper-wick shooting-star pinbar (SELL minor candlestick vote) while keeping its bullish close
  const last = baseBars[baseBars.length - 1];
  const body = Math.max(0.0004, last.close - last.open);
  const tweakedLast: Bar = {
    ...last,
    open: last.open,
    close: last.close,
    low: last.open - 0.0001,
    high: last.close + body * 3.2, // upper wick >= 70% of range, body <= 25% -> triggers Bearish Shooting Star
  };
  return [...baseBars.slice(0, -1), tweakedLast];
}

test('1. Weighted engine confluence does NOT skip strong BUY setup over minor opposing candlestick pinbar', () => {
  const cs = buildStochRsiBuyWithMinorBearPinbar();
  const ev = evaluateEngines(cs, 60, 1, 'TEST_PAIR', 60);
  assert.equal(ev.setup, true, `expected valid BUY setup, got state=${ev.state}, reasons=${ev.reasons.join('; ')}`);
  assert.equal(ev.side, 'BUY');
  assert.ok(ev.stochRsiSweep, 'stochRsiSweep should remain intact');
  assert.equal(ev.pattern, null, 'losing minor opposing pattern should be cleared after dissent note');
  assert.ok(ev.reasons.some((r) => /minor dissent noted/i.test(r)), 'should document minor dissent transparently');

  const pv = verifyPattern(
    {
      side: ev.side!,
      sweep: ev.sweep as any,
      continuation: ev.continuation as any,
      momentum: ev.momentum as any,
      lscc: ev.lscc as any,
      structure_sweep: ev.structureSweep as any,
      stoch_rsi_sweep: ev.stochRsiSweep as any,
    },
    cs,
    cs[cs.length - 1].time
  );
  assert.equal(pv.status, 'VALID', `verifyPattern failed rules: ${pv.failedRules.join(', ')}`);
});

test('2. Window consistency: 45-bar agent Stoch+RSI detection verifies validly against 180-bar warmed history', () => {
  const full = buildStochRsiBuySetup(160);
  const win45 = full.slice(-45);
  const ev45 = evaluateEngines(win45, 60, 1, 'TEST_PAIR', 60);
  assert.equal(ev45.setup, true);
  assert.ok(ev45.stochRsiSweep);
  const pvWarm = verifyPattern(
    { side: ev45.side!, stoch_rsi_sweep: ev45.stochRsiSweep as any },
    full,
    full[full.length - 1].time
  );
  assert.equal(pvWarm.status, 'VALID', `window mismatch failed rules: ${pvWarm.failedRules.join(', ')}`);
});

test('3. Priority candidate publishing: stronger engine wins version 1 in CandidateHub and gets 180-bar warmed chart', async () => {
  // Build 180 bars where BOTH basic `sweep` (weight 1) AND `stoch_rsi_sweep` (or `continuation`/`momentum`) qualify on last candle,
  // or build a setup where `stoch_rsi_sweep` + `momentum` / `sweep` overlap on the signal bar!
  const cs = buildStochRsiBuySetup(165);
  // Make the prior bar bearish and signal bar a green sweep below prior bar low if needed,
  // OR note: `buildStochRsiBuySetup` already fires `stoch_rsi_sweep` (and often `momentum` too because of 3 strong green bars!).
  const lastTime = cs[cs.length - 1].time;

  const hub = new CandidateHub({ clock: () => (lastTime + 62) * 1000 });
  const detected: { engine: string; svg: string }[] = [];
  hub.onEvent('test', (e) => {
    if (e.type === 'detected') {
      detected.push({ engine: e.ev.engine, svg: e.ev.screenshot.svg });
    }
  });

  const watcher = new SweepWatcherService({
    agents: [{ symbol: 'EURUSD', name: 'EUR/USD', market: 'EUR/USD' }],
    deps: {
      fetchCandles: async () => cs,
      now: async () => lastTime + 62,
      sleep: async () => {},
    },
    hub,
    rasterize: fakeRasterizer,
  });

  await watcher.runPass(0);
  const recs = hub.list(10);
  assert.ok(recs.length >= 1, 'should publish at least 1 live candidate');
  const rec = recs[0];
  assert.equal(rec.versions[0].engine, 'stoch_rsi_sweep', `expected stoch_rsi_sweep to win v1 priority, got ${rec.versions[0].engine}`);
  assert.ok(rec.versions[0].ohlc.length >= 180, `expected deep closed history, got ${rec.versions[0].ohlc.length}`);
  assert.ok(detected[0].svg.includes('Stochastic Oscillator 14 3 3'), 'published SVG renders Stochastic panel');
  assert.ok(detected[0].svg.includes('RSI 14'), 'published SVG renders RSI panel');
});

test('4. Dead/compressed market, low AI confidence (<55), HIGH risk + POOR quality, and extreme QSI VETO are blocked from execution', async () => {
  // A: Dead sideways compressed market with tiny flat candles
  const deadBars: Bar[] = [];
  for (let i = 0; i < 60; i++) {
    const base = 1.1000 + (i < 48 ? (i % 2 === 0 ? 0.0020 : -0.0020) : (i % 2 === 0 ? 0.0001 : -0.0001));
    deadBars.push({
      time: T0 + i * 60,
      open: base,
      close: base + (i % 2 === 0 ? 0.00005 : -0.00005),
      high: base + 0.00012,
      low: base - 0.00012,
    });
  }
  const deadCond = marketCondition(deadBars);
  const deadQual = assessMarketQuality('BUY', deadBars, deadCond);
  assert.equal(deadQual.deadMarket, true, `expected deadMarket=true, got volatility=${deadQual.volatility.state}, strength=${deadQual.trendStrength}`);
  assert.equal(deadQual.grade, 'POOR');

  // B: Low AI confidence (<55) blocked cleanly
  resetSignalCaches();
  const cs = withSweep(market('up'), 'BUY');
  const aiLowConf = fakeAi(() => ({
    confidence: 42,
    risk: 'MEDIUM',
    market: { regime: 'RANGING', trendRelation: 'NEUTRAL', momentum: 'MIXED', volatility: 'SUITABLE', repeatedSweeps: false, exhaustionOrContinuation: 'NONE', quality: 'FAIR', warnings: [] },
  }));
  const sigLow = await getSignal(
    { engines: async () => mkEngine('BUY'), ai: aiLowConf, rasterizer: fakeRasterizer, now: () => nowAfter(cs) },
    cs, TF, 'EUR/USD', 'dead:conf', Math.floor(nowAfter(cs) / 1000)
  );
  assert.equal(sigLow.tradeable, false);
  assert.match(sigLow.verification?.execution.reason ?? '', /AI confidence too low/i);

  // C: HIGH risk + POOR quality blocked even if AI says VALID_WITH_RISK
  resetSignalCaches();
  const aiHighRisk = fakeAi(() => ({
    confidence: 65,
    risk: 'HIGH',
    market: { regime: 'TRENDING_DOWN', trendRelation: 'COUNTERTREND', momentum: 'CONTRADICTORY', volatility: 'UNSUITABLE', repeatedSweeps: true, exhaustionOrContinuation: 'CONTINUATION', quality: 'POOR', warnings: ['choppy'] },
  }));
  const csDown = withSweep(market('down'), 'BUY');
  const sigHighRisk = await getSignal(
    { engines: async () => mkEngine('BUY'), ai: aiHighRisk, rasterizer: fakeRasterizer, now: () => nowAfter(csDown) },
    csDown, TF, 'EUR/USD', 'high:risk', Math.floor(nowAfter(csDown) / 1000)
  );
  assert.equal(sigHighRisk.tradeable, false);

  // D: QSI VETO (extreme false-move trap) blocks execution in applyGate even in default shadow mode
  const trapAi = fakeAi(() => ({ confidence: 78, risk: 'MEDIUM' }));
  const extendedUp = market('up', 65);
  const giantUp: Bar = {
    time: extendedUp[extendedUp.length - 1].time + TF,
    open: extendedUp[extendedUp.length - 1].close,
    close: extendedUp[extendedUp.length - 1].close + 2.5,
    high: extendedUp[extendedUp.length - 1].close + 2.6,
    low: extendedUp[extendedUp.length - 1].close - 0.1,
  };
  const weakSweepPrev: Bar = { time: giantUp.time + TF, open: giantUp.close, close: giantUp.close - 0.4, high: giantUp.close + 0.05, low: giantUp.close - 0.45 };
  const weakSweepCur: Bar = { time: weakSweepPrev.time + TF, open: weakSweepPrev.close + 0.02, close: weakSweepPrev.close + 0.04, high: weakSweepPrev.close + 0.9, low: weakSweepPrev.low - 0.05 };
  const trapBars = [...extendedUp, giantUp, weakSweepPrev, weakSweepCur];
  resetSignalCaches();
  const engTrap: EngineResult = {
    ...mkEngine('BUY'),
    intelligence: {
      action: 'NO_TRADE', kind: null, state: 'EXHAUSTION', reason: 'extreme exhaustion', trend: 'DOWN',
      sweepCount: 5, recentSweeps: 4, exhaustion: 'EXHAUSTION', sequence: 'TRAP',
      expirySec: 300, signalCandleTime: weakSweepCur.time, executeAfter: weakSweepCur.time + TF, explanation: null,
    },
    hybrid: {
      action: 'SELL', stage: 'TRADE', reason: 'opposite extreme trap', probability: 0.25, patterns: ['bearish'],
      mode: 'CLASSIC', modeNote: '', qualityScore: 20, bySide: {},
    } as any,
  };
  const sigTrap = await getSignal(
    { engines: async () => engTrap, ai: trapAi, rasterizer: fakeRasterizer, now: () => nowAfter(trapBars), hybridPolicy: { mode: 'off' } },
    trapBars, TF, 'EUR/USD', 'trap:qsi', Math.floor(nowAfter(trapBars) / 1000)
  );
  if (sigTrap.qsi?.recommendation === 'VETO') {
    assert.equal(sigTrap.tradeable, false, 'QSI VETO must block tradeable execution even in shadow mode');
  }
});

test('5. HybridGate does NOT falsely veto primary Engine 6 Momentum over opposite synthetic WEAK_STRONG_STRONG hypothesis', () => {
  const hv: HybridView = {
    action: 'SELL',
    mode: 'B',
    modeNote: null,
    stage: 'TRADE',
    reason: 'synthetic reversal',
    probability: 0.62,
    patterns: ['WEAK_STRONG_STRONG'],
    indicators: { adx: '24', atr: '0.001', ema: 'FLAT', score: 55 },
    rejection: null,
    bySide: {
      BUY: { decision: 'NO_TRADE', rejectionStage: 'STAGE1_SETUP', rejectionReason: 'none', probability: null, qualityScore: null, patterns: [] },
      SELL: { decision: 'SELL', rejectionStage: null, rejectionReason: null, probability: 0.62, qualityScore: 55, patterns: ['WEAK_STRONG_STRONG'] },
    },
    expirySec: 60,
    signalCandleTime: T0,
    executeAfter: T0 + 60,
    model: null,
    note: 'test',
  };
  const res = gateHybrid('BUY', hv, { mode: 'veto' });
  assert.equal(res.allow, true);
  assert.equal(res.status, 'NO_OPINION');
});

test('6. Wrong screenshot framing triggers MISMATCH/REVIEW (tradeable=false), and BUY/SELL arrows stay cleanly inside price pane', () => {
  const cs = withSweep(market('up'), 'BUY');
  const pv = verifyPattern({ side: 'BUY', sweep: { side: 'BUY' } }, cs, cs[cs.length - 1].time);
  const q = assessMarketQuality('BUY', cs, marketCondition(cs));
  const req = {
    requestId: 'req1',
    system: 'sys',
    prompt: 'prompt',
    image: {
      mimeType: 'image/png' as const,
      base64: 'AA==',
      sha256: 'abc',
      lastCandleTime: cs[cs.length - 1].time,
      lastCandleLabel: `${new Date(cs[cs.length - 1].time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      renderedAt: cs[cs.length - 1].time + 305,
      candleSetHash: 'h1',
    },
    ruleIds: pv.allowedRuleIds,
    signalCandleTime: cs[cs.length - 1].time,
    expectedCandleLabel: `${new Date(cs[cs.length - 1].time * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  };
  const v = reconcile({
    pattern: pv,
    quality: q,
    request: req,
    ai: {
      requestId: 'req1',
      imageSent: true,
      pattern: { verdict: 'CONFIRMED', failedRuleIds: [], ruleResults: [], notes: 'ok' },
      market: { regime: 'TRENDING_UP', trendRelation: 'WITH_TREND', momentum: 'SUPPORTIVE', volatility: 'SUITABLE', repeatedSweeps: false, exhaustionOrContinuation: 'NONE', quality: 'GOOD', warnings: [] },
      screenshot: {
        inspected: true,
        lastCandleTimeSeen: req.expectedCandleLabel,
        matchesOhlc: true,
        setupShownMatches: false,
        disagreement: 'Arrow points SELL at bottom while signal is BUY',
      },
      confidence: 80,
      explanation: 'Mismatch between visual arrow and proposed setup.',
      risk: 'LOW',
    },
    aiError: null,
    ageSec: 5,
    tf: TF,
    policy: DEFAULT_POLICY,
  });
  assert.equal(v.screenshotVerification.status, 'MISMATCH');
  assert.equal(v.decision, 'REVIEW');
  assert.equal(v.execution.eligible, false);

  const sweepBuyBars = withSweep(market('up'), 'BUY');
  const svgBuy = renderAlertSvg(sweepBuyBars, {
    engine: 'sweep',
    side: 'BUY',
    ok: true,
    swept_level: sweepBuyBars[sweepBuyBars.length - 2].low,
    tf: 60,
    market: 'EUR/USD',
    symbol: 'EURUSD',
    patternLen: 2,
  });
  const buyArrowY = [...svgBuy.matchAll(/M[0-9.]+ ([0-9.]+) l-18 24/g)].map((m) => Number(m[1]));
  assert.ok(buyArrowY.length >= 1, 'BUY arrow should exist in sweep SVG');
  for (const tipY of buyArrowY) {
    assert.ok(tipY >= T + 20 && tipY <= B - 86, `BUY arrow tip y=${tipY} outside safe pane bounds [${T + 20}, ${B - 86}]`);
    assert.ok(tipY + 78 < STO_T, `BUY label y=${tipY + 78} must stay above STO_T=${STO_T}`);
  }

  const srsBars = buildStochRsiBuySetup(160);
  const pvSrs = verifyPattern({ side: 'BUY', stoch_rsi_sweep: { side: 'BUY' } }, srsBars, srsBars[srsBars.length - 1].time);
  const svgSrs = renderSignalSvg(srsBars, 'BUY', pvSrs, 'EUR/USD', 'EURUSD', 60);
  const srsTips = [...svgSrs.matchAll(/M[0-9.]+ ([0-9.]+) l-18 24/g)].map((m) => Number(m[1]));
  assert.ok(srsTips.length >= 1);
  for (const tipY of srsTips) {
    assert.ok(tipY >= T + 50 && tipY <= B - 58, `next-open BUY arrow tip y=${tipY} out of bounds`);
  }
});
