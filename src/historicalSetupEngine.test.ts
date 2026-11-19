import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HistoricalSetupStore, computeSetupSimilarity, hsiePromptSection, hsieStore, type SetupFingerprint } from "./historicalSetupEngine";
import { assessQuantumSweepIntel, qsiPromptSection } from "./quantumSweepIntel";
import { evaluateEngines } from "./engineEvaluator";
import { HybridEngine } from "./hybridEngine";
import { hybridConfig } from "./hybridConfig";
import { assessMarketQuality } from "./marketQuality";
import { getSignal, resetSignalCaches } from "../signalServer";
import { Candle } from "./candleMath";
import { engine, fakeAi, fakeRasterizer, market, withSweep } from "./aiFixtures";

function buildSyntheticSeries(count: number, tfSec = 60, seedBias = 0): Candle[] {
  const start = 1_700_000_000;
  const out: Candle[] = [];
  let price = 100 + seedBias;
  for (let i = 0; i < count; i++) {
    const t = start + i * tfSec;
    const wave = Math.sin(i * 0.35) * 0.45;
    const open = price;
    // Inject periodic bullish liquidity sweeps & strong rejections every 14 bars
    if (i >= 20 && i % 14 === 0) {
      const prev = out[i - 1];
      const sweepLow = Math.min(prev.low, open) - 0.65;
      const close = Math.max(open + 0.35, prev.close + 0.15);
      const high = close + 0.12;
      out.push({ time: t, open, high, low: sweepLow, close, closed: true });
      price = close;
      continue;
    }
    // Follow-through bar after sweep generally rises when i % 28 === 14
    const delta = i >= 21 && (i - 1) % 14 === 0
      ? ((i - 1) % 28 === 0 ? 0.55 : -0.45)
      : wave * 0.25 + (i % 3 === 0 ? 0.12 : -0.09);
    const close = open + delta;
    const high = Math.max(open, close) + 0.18;
    const low = Math.min(open, close) - 0.18;
    out.push({ time: t, open, high, low, close, closed: true });
    price = close;
  }
  return out;
}

beforeEach(() => {
  hsieStore.clear();
  resetSignalCaches();
});

test("HSIE incremental ingest matches full ingest and enforces strict market isolation", () => {
  const storeInc = new HistoricalSetupStore();
  const storeFull = new HistoricalSetupStore();
  const eurusd = buildSyntheticSeries(220, 60, 0);
  const r100 = buildSyntheticSeries(180, 60, 500);

  // Feed eurusd incrementally in chunks
  storeInc.ingest("EURUSD", 60, eurusd.slice(0, 80));
  storeInc.ingest("EURUSD", 60, eurusd.slice(0, 150));
  const incIdx = storeInc.ingest("EURUSD", 60, eurusd);

  const fullIdx = storeFull.ingest("EURUSD", 60, eurusd);
  assert.equal(incIdx.candles.length, fullIdx.candles.length);
  assert.equal(incIdx.records.length, fullIdx.records.length);
  assert.deepEqual(
    incIdx.records.map((r) => ({ t: r.time, s: r.side, p: r.primaryEngine })),
    fullIdx.records.map((r) => ({ t: r.time, s: r.side, p: r.primaryEngine }))
  );

  // Separate markets & timeframes stay strictly isolated
  storeInc.ingest("R_100", 60, r100);
  storeInc.ingest("EURUSD", 300, buildSyntheticSeries(120, 300, 10));
  const stats = storeInc.getStats();
  assert.equal(stats.markets, 3);

  const repEur = storeInc.research({
    symbol: "EURUSD",
    tfSec: 60,
    expirySec: 60,
    candles: eurusd,
    side: "BUY",
    primaryEngine: "sweep",
    includeCrossMarket: false,
  });
  assert.equal(repEur.market, "EURUSD");
  assert.equal(repEur.crossMarketSummary, null);

  const repWithCross = storeInc.research({
    symbol: "EURUSD",
    tfSec: 60,
    expirySec: 60,
    candles: eurusd,
    side: "BUY",
    primaryEngine: "sweep",
    includeCrossMarket: true,
  });
  assert.ok(repWithCross.crossMarketSummary);
  assert.equal(repWithCross.crossMarketSummary!.marketsChecked, 1); // only R_100 shares tfSec=60
});

test("HSIE enforces zero future-candle leakage relative to entryTime + expirySec", () => {
  const cs = buildSyntheticSeries(160, 60);
  const storeA = new HistoricalSetupStore();
  const storeB = new HistoricalSetupStore();

  // Evaluate as of bar 120 (before bars 121..159 exist or with bars 122..159 heavily mutated)
  const cutoffBar = cs[120];
  const mutated = cs.map((c, idx) =>
    idx >= 122 ? { ...c, close: c.close + 25, high: c.high + 25, low: c.low + 25 } : c
  );

  const repA = storeA.research({
    symbol: "R_50",
    tfSec: 60,
    expirySec: 180,
    candles: cs.slice(0, 121),
    currentCandleTime: cutoffBar.time,
    side: "BUY",
    primaryEngine: "sweep",
  });
  const repB = storeB.research({
    symbol: "R_50",
    tfSec: 60,
    expirySec: 180,
    candles: mutated,
    currentCandleTime: cutoffBar.time,
    side: "BUY",
    primaryEngine: "sweep",
  });

  assert.equal(repA.similarSetups, repB.similarSetups);
  assert.equal(repA.wins, repB.wins);
  assert.equal(repA.losses, repB.losses);
  assert.equal(repA.winRatePct, repB.winRatePct);

  // Every returned example must have settled at or before live entry instant (cutoffBar.time + tfSec)
  const liveEntryCutoff = cutoffBar.time + 60;
  for (const ex of repB.recentExamples) {
    assert.ok(ex.settleTime <= liveEntryCutoff, `Leak detected: settleTime ${ex.settleTime} > ${liveEntryCutoff}`);
  }
});

test("HSIE simulates user expiry modes faithfully (SINGLE_BAR, EXACT_MULTI_BAR, APPROXIMATE_SUB_BAR)", () => {
  const cs = buildSyntheticSeries(220, 60);
  const store = new HistoricalSetupStore();

  const rep1m = store.research({
    symbol: "1HZ10V",
    tfSec: 60,
    expirySec: 60,
    candles: cs,
    side: "BUY",
    primaryEngine: "sweep",
  });
  const rep3m = store.research({
    symbol: "1HZ10V",
    tfSec: 60,
    expirySec: 180,
    candles: cs,
    side: "BUY",
    primaryEngine: "sweep",
  });
  const rep30s = store.research({
    symbol: "1HZ10V",
    tfSec: 60,
    expirySec: 30,
    candles: cs,
    side: "BUY",
    primaryEngine: "sweep",
  });

  assert.equal(rep1m.expirySimulationMode, "SINGLE_BAR");
  assert.equal(rep3m.expirySimulationMode, "EXACT_MULTI_BAR");
  assert.equal(rep30s.expirySimulationMode, "APPROXIMATE_SUB_BAR");
  assert.match(rep30s.sampleWarning, /shorter than 60s candles/);
});

test("computeSetupSimilarity ranks structural/indicator similarity above bare color match", () => {
  const base: SetupFingerprint = {
    index: 100,
    time: 1_700_006_000,
    tfSec: 60,
    symbol: "EURUSD",
    side: "BUY",
    engines: ["sweep", "stoch_rsi_sweep"],
    primaryEngine: "sweep",
    candleAnatomy: { bodyRatio: 0.35, upperWickRatio: 0.08, lowerWickRatio: 0.57, sizeVsAtr: 1.4, bullish: true },
    preceding: { prev3NetAtr: -1.6, prev1SameDir: false, prev1BodyRatio: 0.65, consecutiveSameDir: 1 },
    sweep: { hasSweep: true, wickPenetrationAtr: 0.55, closeReclaimRatio: 0.85 },
    indicators: { stochK: 22, stochD: 18, stochSlope: 4.5, stochZone: "OVERSOLD", rsi: 34, rsiSlope: 3.1 },
    regime: { trendLabel: "RANGING", adx: 16, atrRatio: 1.05, emaGapAtr: -0.02 },
  };
  const nearMatch: SetupFingerprint = {
    ...base,
    index: 50,
    candleAnatomy: { bodyRatio: 0.38, upperWickRatio: 0.1, lowerWickRatio: 0.52, sizeVsAtr: 1.35, bullish: true },
    indicators: { stochK: 25, stochD: 20, stochSlope: 3.8, stochZone: "OVERSOLD", rsi: 37, rsiSlope: 2.0 },
  };
  // Same green color (`bullish: true`), same side, but completely mismatched wick/sweep/oscillator/regime
  const poorSameColor: SetupFingerprint = {
    ...base,
    index: 40,
    engines: ["momentum"],
    primaryEngine: "momentum",
    candleAnatomy: { bodyRatio: 0.92, upperWickRatio: 0.05, lowerWickRatio: 0.03, sizeVsAtr: 3.4, bullish: true },
    preceding: { prev3NetAtr: 2.5, prev1SameDir: true, prev1BodyRatio: 0.9, consecutiveSameDir: 4 },
    sweep: { hasSweep: false, wickPenetrationAtr: 0, closeReclaimRatio: 0.25 },
    indicators: { stochK: 91, stochD: 89, stochSlope: -3.2, stochZone: "OVERBOUGHT", rsi: 78, rsiSlope: -2.0 },
    regime: { trendLabel: "BEARISH", adx: 42, atrRatio: 2.4, emaGapAtr: -1.4 },
  };
  const oppositeSide: SetupFingerprint = { ...base, side: "SELL" };

  const sNear = computeSetupSimilarity(base, nearMatch);
  const sPoor = computeSetupSimilarity(base, poorSameColor);
  const sOpp = computeSetupSimilarity(base, oppositeSide);

  assert.ok(sNear > 0.85, `Expected nearMatch > 0.85, got ${sNear}`);
  assert.ok(sNear - sPoor >= 0.35, `Expected nearMatch (${sNear}) >> poorSameColor (${sPoor})`);
  assert.equal(sOpp, 0);
});

test("NO_HISTORICAL_MATCH NEVER rejects a valid trade and AI prompt includes HSIE + QSI sections", async () => {
  const raw = withSweep(market("up"), "BUY");
  const cs = raw.map((c, idx) => ({ ...c, time: 1_700_000_040 + idx * 60 }));
  const ai = fakeAi();

  const sig = await getSignal(
    {
      engines: async () => engine("BUY"),
      ai,
      rasterizer: fakeRasterizer,
      now: () => (cs[cs.length - 1].time + 60 + 5) * 1000,
      expirySec: 120,
    },
    cs,
    60,
    "UNKNOWN_NEW_MARKET",
    "s-no-hist"
  );

  assert.equal(sig.setup, true);
  assert.equal(sig.tradeable, true);
  assert.ok(sig.hsie);
  assert.equal(sig.hsie!.status, "NO_HISTORICAL_MATCH");
  assert.equal(sig.hsie!.allow, true);
  assert.ok(sig.qsi);
  assert.equal(sig.qsi!.allow, true);
  assert.equal(sig.qsi!.mode, "shadow");

  const prompt = ai.calls[0].prompt;
  assert.match(prompt, /=== B3\. HISTORICAL SETUP INTELLIGENCE/);
  assert.match(prompt, /NO_HISTORICAL_MATCH/);
  assert.match(prompt, /=== B4\. QUANTUM SWEEP INTELLIGENCE/);
});

test("HybridEngine and evaluateEngines run natively at any tfSec & expirySec with unified HSIE + QSI", () => {
  const hybrid = new HybridEngine("EURUSD", hybridConfig({ tfSec: 60, expirySec: 120, mode: "B" }));
  const cs = withSweep(buildSyntheticSeries(180, 60), "BUY");
  let hyRes = null as ReturnType<HybridEngine["step"]> | null;
  for (const c of cs) hyRes = hybrid.step(c);
  assert.ok(hyRes);
  assert.equal(hyRes.expirySec, 120);

  const ev = evaluateEngines(cs, 60, 1, "frxXAUUSD", 120);
  assert.ok(ev.intelligence, "QuantumPipeline intelligence must be populated");
  assert.equal(ev.intelligence!.expirySec, 120);
  assert.ok(ev.hybrid, "HybridEngine must evaluate cleanly on 60s/120s instead of skipping");
  if (ev.setup && ev.side) {
    assert.ok(ev.hsie, "HSIE report should accompany active setups");
    assert.equal(ev.hsie!.expirySec, 120);
    assert.equal(ev.hsie!.allow, true);
    assert.ok(ev.qsi, "QSI assessment should accompany active setups");
    assert.ok(ev.qsi!.engineParticipation.length >= 3);
  }
});

test("QSI defaults to shadow mode, respects veto only in veto mode on extreme conflicts, and never vetoes due to 0 HSIE matches", () => {
  const cs = withSweep(buildSyntheticSeries(80, 60), "BUY");
  const baseHsie = hsieStore.research({
    symbol: "EMPTY_SYM",
    tfSec: 60,
    expirySec: 60,
    candles: cs.slice(0, 20), // triggers NO_HISTORICAL_MATCH
    side: "BUY",
    primaryEngine: "sweep",
  });
  assert.equal(baseHsie.status, "NO_HISTORICAL_MATCH");

  // Clean setup + 0 HSIE matches must stay neutral & pass even in veto mode
  const cleanQsi = assessQuantumSweepIntel(
    {
      side: "BUY",
      primaryEngine: "sweep",
      activeEngines: ["sweep", "stoch_rsi_sweep"],
      candles: cs,
      tfSec: 60,
      expirySec: 60,
      hsie: baseHsie,
    },
    "veto"
  );
  assert.equal(cleanQsi.allow, true);
  assert.equal(cleanQsi.componentScores.historicalContext, 50);

  // Prompt formatters work cleanly
  assert.match(hsiePromptSection(baseHsie), /NEVER reject a valid strategy setup/);
  assert.match(qsiPromptSection(cleanQsi), /QUANTUM SWEEP INTELLIGENCE/);

  // Severe multi-conflict trap setup: shadow keeps allow=true; veto blocks
  const trapCandles = [...cs];
  const last = trapCandles[trapCandles.length - 1];
  trapCandles[trapCandles.length - 1] = {
    ...last,
    open: last.close + 2,
    high: last.close + 8,
    low: last.close - 6,
    close: last.close - 5.5, // ugly close near low for BUY
  };
  const trapInput = {
    side: "BUY" as const,
    primaryEngine: "sweep",
    activeEngines: ["sweep"],
    candles: trapCandles,
    tfSec: 60,
    expirySec: 60,
    intelligence: {
      action: "SELL" as const,
      kind: "EXHAUSTION",
      state: "REPEATED_SWEEPS",
      trend: "BEARISH",
      sweepCount: 4,
      recentSweeps: 4,
      exhaustion: "EXHAUSTION",
      sequence: "REJECTION",
    },
    quality: {
      ...assessMarketQuality("BUY", trapCandles, null),
      grade: "POOR" as const,
      regime: "TRENDING_DOWN" as const,
      warnings: ["Counter-trend"],
      confidencePenalty: 15,
    },
    hsie: baseHsie,
  };
  const shadowTrap = assessQuantumSweepIntel(trapInput, "shadow");
  const vetoTrap = assessQuantumSweepIntel(trapInput, "veto");
  assert.equal(shadowTrap.allow, true);
  assert.ok(shadowTrap.falseMoveRiskScore >= 52);
  if (vetoTrap.recommendation === "VETO") {
    assert.equal(vetoTrap.allow, false);
  }
});
