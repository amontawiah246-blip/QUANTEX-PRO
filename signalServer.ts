// The signal pipeline:  candles -> engines (sweep, Engine 5, Engine 6, indicators, candlestick; run in the bridge)
//   -> PATTERN VALIDITY   recomputed from the OHLC (src/patternVerification.ts); only the original strategy rules count
//   -> MARKET QUALITY     trend / indicators / momentum / volatility / repeated sweeps (src/marketQuality.ts); ranking + warnings only
//   -> AI VERIFICATION    Gemini gets the SCREENSHOT + the OHLC + the engine findings + the indicator context (src/aiVerification.ts)
//   -> DECISION           APPROVED | VALID_WITH_RISK | REJECTED | REVIEW | AI_UNAVAILABLE
//   -> EXECUTION CONTROLLER  decideExecution() applies the user's policy; `tradeable` is its answer.
// The chart itself is never touched: everything here runs in the background. Engines 5 and 6 are only read, never changed.
import type { Express } from 'express';
import { Condition, marketCondition, setupKind } from './src/conditions';
import { assessMarketQuality } from './src/marketQuality';
import { verifyPattern } from './src/patternVerification';
import {
  AiAssessment, AiCaller, AiRequest, AiUnavailableError, Decision, EngineView, ExecutionLedger, ExecutionPolicy, ScreenshotImage, Verification,
  buildAiRequest, candleSetHash, parseAiResponse, policyFromEnv, reconcile,
} from './src/aiVerification';
import { Rasterizer, buildScreenshot, defaultRasterizer } from './src/screenshot';
import { DEFAULT_MODEL, createGeminiCaller } from './src/geminiVision';
import type { HybridView } from './src/hybridEngine';
import { HybridGatePolicy, HybridGateResult, gateHybrid, hybridGatePolicyFromEnv } from './src/hybridGate';
import { buildHybridEvidence, hybridEvidenceHash, hybridPromptSection } from './src/hybridEvidence';
import { AiContract, toAiContract } from './src/aiContract';
import { TradeLog } from './src/tradeLog';
import { liveConfidence, type LiveConfidence } from './src/liveConfidence';
import { getGlobalTiming, isSupportedTimeframe } from './src/globalConfig';
import type { IntelligenceView } from './src/engineEvaluator';
import { hsiePromptSection, hsieStore, type HsieReport } from './src/historicalSetupEngine';
import { assessQuantumSweepIntel, qsiPromptSection, type QsiAssessment } from './src/quantumSweepIntel';

export interface Cand { time: number; open: number; high: number; low: number; close: number }
export interface EngineResult {
  status: string; setup: boolean; side: 'BUY' | 'SELL' | null; confidence: number; agree: number; candles: number;
  sweep: { side: string; reasons: string[] } | null;
  indicators: { side: string; strategies: string[]; count: number; info?: Record<string, number> } | null;
  pattern: { side: string; patterns: string[]; counted: boolean } | null;
  continuation?: { side: string; reasons: string[] } | null;   // Engine 5
  momentum?: { side: string; reasons: string[] } | null;       // Engine 6
  lscc?: { side: string; reasons: string[] } | null;           // LSCC: liquidity sweep + separate confirmation candle
  structureSweep?: { side: string; reasons: string[]; biasDirection?: string; eventType?: string; breakLevel?: number } | null;
  stochRsiSweep?: { side: string; reasons: string[]; stochK: number; stochD: number; rsi: number; confirmations: string[] } | null;
  rsi?: number;
  stochK?: number;
  stochD?: number;
  reasons: string[];
  /** Engines 7-12 unified structure/sweep/exhaustion verdict */
  intelligence?: IntelligenceView;
  /** the hybrid engine's verdict for the newest closed candle (src/hybridEngine.ts). The strategy engines above are never changed by it. */
  hybrid?: HybridView;
  /** HSIE Historical Setup Intelligence report (strictly empirical & non-blocking) */
  hsie?: HsieReport | null;
  /** QSI Quantum Sweep Intelligence false-move risk assessment */
  qsi?: QsiAssessment | null;
}
/** Kept for the existing UI: the old approve/veto shape, now derived from the decision. */
export interface AiVerdict { status: 'approved' | 'vetoed' | 'unavailable' | 'review'; adjust: number; reason: string; risks: string[] }
export interface Signal {
  setup: boolean; tradeable: boolean; side: 'buy' | 'sell' | null; confidence: number;
  status: string; reasons: string[]; engine: EngineResult; ai: AiVerdict | null; candleTime: number; tf: number;
  condition: Condition | null; setupName: string;   // the "Market condition" box
  decision: Decision | null;                        // null = the engines found no setup
  verification: Verification | null;
  /** hybrid gate result for this setup (null = no setup) */
  hybrid: HybridGateResult | null;
  /** Engines 7-12 structural view */
  intelligence?: IntelligenceView | null;
  /** HSIE Historical Setup Intelligence Engine research report (never blocks trades on missing history) */
  hsie?: HsieReport | null;
  /** QSI Quantum Sweep Intelligence unified false-move risk report */
  qsi?: QsiAssessment | null;
  /** the verdict in the project's response contract (APPROVE | REJECT | ABSTAIN | RETRY ...), derived from `verification` */
  contract: AiContract | null;
  /** id of the screenshot the AI inspected: GET /api/signal/screenshot/:id */
  screenshotId: string | null;
  /** measured win rate of similar past setups from the trade log (null = no setup, or not computed). `confidence` above is only the engines' agreement. */
  live: LiveConfidence | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export async function runEngines(port: number, candles: Cand[], tf: number, nowSec?: number, symbol?: string, expirySec?: number): Promise<EngineResult> {
  const r = await fetch(`http://127.0.0.1:${port}/api/engines`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candles, tf, minInd: 1, now: nowSec, symbol, expirySec }), signal: AbortSignal.timeout(20000),
  });
  const d: any = await r.json();
  if (d.status !== 'ok') throw new Error(d.msg || 'engine error');
  return { ...d, status: String(d.state ?? '') } as EngineResult;
}

/** Maps the decision onto the old ai object the UI reads. */
function legacyAi(v: Verification, penalty: number): AiVerdict {
  const status = v.decision === 'REJECTED' ? 'vetoed' : v.decision === 'REVIEW' ? 'review' : v.decision === 'AI_UNAVAILABLE' ? 'unavailable' : 'approved';
  return { status, adjust: -penalty, reason: (v.decisionReasons[0] ?? v.explanation).slice(0, 240), risks: v.marketQuality.warnings.slice(0, 4).map((w) => w.slice(0, 120)) };
}

const noSetup = (engine: EngineResult, candleTime: number, tf: number): Signal => ({
  engine, ai: null, candleTime, tf, side: null, condition: null, setupName: 'None', setup: false, tradeable: false, confidence: 0,
  status: engine.status, reasons: engine.reasons, decision: null, verification: null, hybrid: null,
  intelligence: engine.intelligence ?? null, hsie: engine.hsie ?? null, qsi: engine.qsi ?? null,
  contract: null, screenshotId: null, live: null,
});

/** Builds the final Signal from the engine result and the verification. The engine result is always kept untouched in `engine`. */
export function merge(engine: EngineResult, v: Verification | null, candleTime: number, tf: number): Signal {
  if (!engine.setup || !v) return noSetup(engine, candleTime, tf);
  const side: 'buy' | 'sell' | null = engine.side === 'BUY' ? 'buy' : engine.side === 'SELL' ? 'sell' : null;
  const base = { engine, candleTime, tf, condition: null as Condition | null, setupName: 'None', decision: v.decision, verification: v, hybrid: v.hybrid ?? null, intelligence: engine.intelligence ?? null, hsie: engine.hsie ?? null, qsi: engine.qsi ?? null, contract: null as AiContract | null, screenshotId: v.requestId ?? null, live: null as LiveConfidence | null };
  const hyBlock = v.hybrid && !v.hybrid.allow ? `Blocked by the hybrid gate (${v.hybrid.mode}): ${v.hybrid.reason}` : '';
  const penalty = v.decision === 'AI_UNAVAILABLE' ? 0 : v.marketQuality.confidencePenalty;
  const ai = legacyAi(v, penalty);
  const why = v.decisionReasons.join('. ');
  switch (v.decision) {
    case 'REJECTED':
      return { ...base, ai, side: null, setup: false, tradeable: false, confidence: 0, status: `Rejected: ${why}`, reasons: [...engine.reasons, `Rejected: ${why}`] };
    case 'REVIEW': {
      const baseConf = clamp(engine.confidence - penalty, 0, 95);
      const conf = v.aiConfidence !== null ? Math.min(baseConf, clamp(v.aiConfidence, 0, 95)) : baseConf;
      return { ...base, ai, side, setup: true, tradeable: false, confidence: conf, status: `Needs review: ${why}`, reasons: [...engine.reasons, `Review: ${why}`] };
    }
    case 'AI_UNAVAILABLE':
      return { ...base, ai, side, setup: true, tradeable: v.execution.eligible, confidence: engine.confidence, status: `AI unavailable: engine setup kept, not visually verified`, reasons: [...engine.reasons, `AI unavailable: ${v.aiError?.message ?? 'no answer'}`] };
    default: {
      const warn = v.marketQuality.warnings.slice(0, 3);
      const baseConf = clamp(engine.confidence - penalty, 0, 95);
      const conf = v.aiConfidence !== null ? Math.min(baseConf, clamp(v.aiConfidence, 0, 95)) : baseConf;
      return {
        ...base, ai, side, setup: true, tradeable: v.execution.eligible, confidence: conf,
        status: hyBlock || (!v.execution.eligible ? v.execution.reason : v.decision === 'APPROVED' ? 'Verified by the AI' : 'Valid with risk'),
        reasons: [...engine.reasons, `${v.decision === 'APPROVED' ? 'AI approved' : 'Valid with risk'}: ${v.explanation || why}`, ...(hyBlock ? [hyBlock] : []), ...(!hyBlock && !v.execution.eligible ? [`Execution blocked: ${v.execution.reason}`] : []), ...warn.map((w) => `Warning: ${w}`)],
      };
    }
  }
}

// ------------------------------------------------------------------------------------------------ AI call: cache + in-flight dedupe
interface Cached { at: number; request: AiRequest; ai: AiAssessment }
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<Cached>>();
const TTL_MS = 180000;
export const ledger = new ExecutionLedger();
export function resetSignalCaches() { cache.clear(); inflight.clear(); }

export interface SignalDeps {
  engines(candles: Cand[], tf: number, nowSec?: number, symbol?: string, expirySec?: number): Promise<EngineResult>;
  /** null = no AI configured: every setup becomes AI_UNAVAILABLE (never an approval) */
  ai: AiCaller | null;
  /** SVG -> PNG. undefined = the default (resvg / sharp when installed); null = no screenshots */
  rasterizer?: Rasterizer | null;
  policy?: ExecutionPolicy;
  /** Explicit trade expiry in seconds (defaults to globalConfig active expirySec) */
  expirySec?: number;
  /** how the hybrid engine may influence trading (default: HYBRID_AUTOTRADE env, else veto-only) */
  hybridPolicy?: HybridGatePolicy;
  /**
   * A screenshot that was ALREADY captured for exactly these candles (the market agent's candidate screenshot). When it is given, no second
   * screenshot is drawn: the AI receives this one. It must end on the signal candle and carry the hash of the 60 rows the AI prompt carries,
   * otherwise it is refused as inconsistent evidence (the setup is then AI_UNAVAILABLE, never an approval).
   */
  image?: ScreenshotImage | null;
  /** called once per computed signal (used for the execution log) */
  observe?: (sig: Signal, ctx: { key: string; label: string; closed: Cand[] }) => void;
  now?: () => number;
}

async function verify(d: SignalDeps, engine: EngineResult, closed: Cand[], tf: number, label: string, key: string, now: number, ageSec: number) {
  const side = engine.side as 'BUY' | 'SELL';
  const policy = d.policy ?? policyFromEnv();
  const expirySec = d.expirySec && d.expirySec > 0 ? d.expirySec : getGlobalTiming().expirySec;
  const cleanSym = key.split(':').pop() ?? key;
  const candleTime = closed.length ? closed[closed.length - 1].time : 0;
  const pattern = verifyPattern({
    side,
    sweep: engine.sweep as any,
    continuation: engine.continuation as any,
    momentum: engine.momentum as any,
    lscc: engine.lscc as any,
    structure_sweep: engine.structureSweep as any,
    stoch_rsi_sweep: engine.stochRsiSweep as any,
  }, closed, candleTime);
  const condition = marketCondition(closed);
  const quality = assessMarketQuality(side, closed, condition);
  const base = { pattern, quality, ageSec, tf, policy };
  const maxAge = policy.maxSignalAgeSec ?? Math.max(20, tf * 0.5);
  const stale = ageSec > maxAge;

  const activeEngines = pattern.claimed.map((c) => c.engine);
  const primaryEngine = activeEngines[0] || 'sweep';
  let hsie: HsieReport | null = engine.hsie ?? null;
  if (!hsie || hsie.expirySec !== expirySec || hsie.tfSec !== tf || hsie.candlesEvaluated < closed.length) {
    try {
      hsie = hsieStore.research({
        symbol: cleanSym,
        tfSec: tf,
        expirySec,
        candles: closed,
        side,
        primaryEngine,
        activeEngines,
        includeCrossMarket: true,
      });
    } catch {
      hsie = null;
    }
  }

  let qsi: QsiAssessment | null = null;
  try {
    qsi = assessQuantumSweepIntel({
      side,
      primaryEngine,
      activeEngines,
      candles: closed,
      tfSec: tf,
      expirySec,
      intelligence: engine.intelligence ?? null,
      hybrid: engine.hybrid ?? null,
      quality,
      hsie,
    });
  } catch {
    qsi = engine.qsi ?? null;
  }

  // The hybrid layer is judged AFTER the strategy: it can only add evidence and, in veto/require mode, block. It can never create or loosen a setup.
  const gate = gateHybrid(side, engine.hybrid, d.hybridPolicy ?? hybridGatePolicyFromEnv());
  const evidence = buildHybridEvidence({ label, tf, expirySec, side, closed, pattern, quality, gate, ageSec, maxAgeSec: maxAge });
  const applyGate = (v: Verification, requestId: string | null): Verification => {
    v.hybrid = gate; v.requestId = requestId;
    if (!gate.allow && v.execution.eligible) v.execution = { ...v.execution, eligible: false, reason: `hybrid gate (${gate.mode}): ${gate.reason}` };
    if (qsi && ((qsi.mode === 'veto' && !qsi.allow) || qsi.recommendation === 'VETO') && v.execution.eligible) {
      v.execution = { ...v.execution, eligible: false, reason: qsi.summary };
    }
    return v;
  };

  // No AI call when the arithmetic already decides (invalid pattern, missing evidence) or the signal is stale
  if (pattern.status === 'INVALID' || pattern.status === 'INSUFFICIENT_EVIDENCE' || stale) {
    return { condition, v: applyGate(reconcile({ ...base, request: null, ai: null, aiError: null }), null), hsie, qsi };
  }
  if (!d.ai) return { condition, v: applyGate(reconcile({ ...base, request: null, ai: null, aiError: new AiUnavailableError('NOT_CONFIGURED', 'no AI configured (set GEMINI_API_KEY)') }), null), hsie, qsi };

  const rows = closed.slice(-60);
  if (d.image) {
    const why = d.image.lastCandleTime !== candleTime ? `the supplied screenshot ends on ${d.image.lastCandleTime}, the signal candle is ${candleTime}`
      : d.image.candleSetHash !== candleSetHash(rows) ? 'the supplied screenshot was drawn from a different candle set than the numeric data' : '';
    if (why) return { condition, v: applyGate(reconcile({ ...base, request: null, ai: null, aiError: new AiUnavailableError('WRONG_REQUEST', `inconsistent evidence: ${why}`) }), null), hsie, qsi };
  }
  const sig: EngineView = {
    side, confidence: engine.confidence, agree: engine.agree, reasons: engine.reasons,
    indicators: engine.indicators ? { strategies: engine.indicators.strategies, info: engine.indicators.info } : null,
    pattern: engine.pattern ? { patterns: engine.pattern.patterns } : null,
  };
  const idKey = `${key}|${tf}|${expirySec}|${candleTime}|${side}|${candleSetHash(rows)}|${hybridEvidenceHash(evidence)}|${d.image?.sha256 ?? ''}`;
  const hit = cache.get(idKey);
  if (hit && now - hit.at < TTL_MS) return { condition, v: applyGate(reconcile({ ...base, request: hit.request, ai: hit.ai, aiError: null, cacheHit: true }), hit.request.requestId), hsie, qsi };

  let pending = inflight.get(idKey);
  if (!pending) {
    pending = (async (): Promise<Cached> => {
      const raster = d.rasterizer === undefined ? defaultRasterizer : d.rasterizer;
      const image = d.image !== undefined ? d.image : raster ? await buildScreenshot(closed, side, pattern, label, key.split(':').pop() ?? key, tf, raster, now) : null;
      const request = buildAiRequest({
        engine: sig,
        label,
        tf,
        expirySec,
        closed,
        pattern,
        quality,
        condition,
        image,
        key,
        hybridSection: gate.mode === 'off' ? null : hybridPromptSection(evidence),
        hsieSection: hsiePromptSection(hsie),
        qsiSection: qsiPromptSection(qsi, engine.intelligence ?? null),
      });
      const res = await d.ai!(request);
      const ai = parseAiResponse(res.text, request, !!request.image && res.imageSent === true);
      const entry = { at: now, request, ai };
      cache.set(idKey, entry);                                   // only a real, valid answer is cached; failures are retried
      if (cache.size > 200) cache.delete(cache.keys().next().value as string);
      return entry;
    })().finally(() => { inflight.delete(idKey); });
    inflight.set(idKey, pending);
  }
  try {
    const e = await pending;
    return { condition, v: applyGate(reconcile({ ...base, request: e.request, ai: e.ai, aiError: null }), e.request.requestId), hsie, qsi };
  } catch (err) {
    const aiError = err instanceof AiUnavailableError ? err : new AiUnavailableError('NETWORK', `AI call failed: ${(err as Error)?.message ?? err}`.slice(0, 160));
    return { condition, v: applyGate(reconcile({ ...base, request: null, ai: null, aiError }), null), hsie, qsi };
  }
}

/** nowSec = the broker's clock in seconds (from a live tick). Candle times follow the broker's clock, so closed/forming is decided with it. */
export async function getSignal(d: SignalDeps, candles: Cand[], tf: number, label: string, key: string, nowSec?: number): Promise<Signal> {
  const now = nowSec != null ? nowSec * 1000 : d.now ? d.now() : Date.now();
  const closed = candles.length && candles[candles.length - 1].time >= Math.floor(now / 1000 / tf) * tf ? candles.slice(0, -1) : candles;
  const candleTime = closed.length ? closed[closed.length - 1].time : 0;
  const expirySec = d.expirySec && d.expirySec > 0 ? d.expirySec : getGlobalTiming().expirySec;
  const engine = await d.engines(candles, tf, nowSec, key.split(':').pop(), expirySec);
  if (!engine.setup || !engine.side) {
    const ns = noSetup(engine, candleTime, tf);
    try { d.observe?.(ns, { key, label, closed }); } catch { /* logging must never change a signal */ }
    return ns;
  }

  const ageSec = now / 1000 - (candleTime + tf);
  const { condition, v, hsie, qsi } = await verify(d, engine, closed, tf, label, key, now, ageSec);
  const sig = merge(engine, v, candleTime, tf);
  sig.hsie = hsie ?? engine.hsie ?? null;
  sig.qsi = qsi ?? engine.qsi ?? null;
  sig.intelligence = engine.intelligence ?? null;
  sig.condition = condition;     // the dashboard's own measurements, untouched: the engine's sweep is reported in `verification`, not written into them
  const names = [
    ...(engine.stochRsiSweep ? ['stoch_rsi_sweep'] : []),
    ...(engine.sweep || engine.continuation || engine.structureSweep ? ['sweep'] : []),
    ...(engine.pattern ? ['pat'] : []),
  ];
  sig.setupName = setupKind(sig.setup ? sig.side : null, condition, names);
  sig.contract = toAiContract(v, engine.side, now);
  try { d.observe?.(sig, { key, label, closed }); } catch { /* logging must never change a signal */ }
  return sig;
}

/** The PNG the AI inspected for this request id (kept in the same cache as the AI answer). null = unknown or expired. */
export function screenshotPng(requestId: string): Buffer | null {
  for (const e of cache.values()) if (e.request.requestId === requestId && e.request.image) return Buffer.from(e.request.image.base64, 'base64');
  return null;
}

/** One log for the whole server: signals (strategy-only and AI cohorts), gate results, orders, outcomes. */
export const tradeLog = new TradeLog();
function observeSignal(sig: Signal, ctx: { key: string; label: string; closed: Cand[] }) {
  tradeLog.resolveShadows(ctx.key, ctx.closed);
  if (!sig.setup || !sig.side) return;
  const v = sig.verification;
  const pattern = v?.enginePatternValidity.claimedEngines.join('+') || 'indicator_or_candlestick';
  sig.live = liveConfidence(tradeLog.events(), { market: ctx.key, tf: sig.tf, pattern });   // computed BEFORE this setup is logged, so it never counts itself
  tradeLog.candidate({
    market: ctx.key, label: ctx.label, tf: sig.tf, candleTime: sig.candleTime, side: sig.side === 'buy' ? 'BUY' : 'SELL',
    pattern, engineConfidence: sig.engine.confidence, decision: sig.decision ?? 'NONE',
    aiContract: sig.contract, hybridStatus: sig.hybrid?.status ?? null, hybridAllow: sig.hybrid ? sig.hybrid.allow : null, hybridProbability: sig.hybrid?.probability ?? null,
    screenshotStatus: v?.screenshotVerification.status ?? null, visualDisagreement: v?.screenshotVerification.status === 'MISMATCH' || v?.screenshotVerification.status === 'STALE',
    tradeable: sig.tradeable, aiError: v?.aiError ? `${v.aiError.kind}: ${v.aiError.message}`.slice(0, 160) : null,
  });
}

let activePolicy: ExecutionPolicy = policyFromEnv();
export function getActivePolicy(): ExecutionPolicy { return activePolicy; }
export function setActivePolicy(p: Partial<ExecutionPolicy>) {
  activePolicy = { ...activePolicy, ...p };
}

let caller: AiCaller | null | undefined;
/** For tests: use this AI instead of Gemini. */
export function setAiCaller(c: AiCaller | null) { caller = c; }
export function liveDeps(port: number): SignalDeps {
  if (caller === undefined) caller = createGeminiCaller();
  return { engines: (c, tf, n, sym, exp) => runEngines(port, c, tf, n, sym, exp), ai: caller, observe: observeSignal, policy: activePolicy };
}

let rasterOk: boolean | undefined;
async function rasterizerAvailable() {
  if (rasterOk === undefined) { try { rasterOk = !!(await defaultRasterizer('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>')); } catch { rasterOk = false; } }
  return rasterOk;
}

export function registerSignalRoutes(app: Express, port: number) {
  app.get('/api/signal/policy', (_req, res) => {
    res.json({ status: 'ok', policy: activePolicy });
  });

  app.post('/api/signal/policy', (req, res) => {
    const p = req.body || {};
    if (typeof p.aiUnavailable === 'string') {
      activePolicy.aiUnavailable = p.aiUnavailable === 'allow_engine_only' ? 'allow_engine_only' : 'block';
    }
    if (typeof p.allowValidWithRisk === 'boolean') activePolicy.allowValidWithRisk = p.allowValidWithRisk;
    if (typeof p.allowCountertrend === 'boolean') activePolicy.allowCountertrend = p.allowCountertrend;
    if (typeof p.requireScreenshot === 'boolean') activePolicy.requireScreenshot = p.requireScreenshot;
    res.json({ status: 'ok', policy: activePolicy });
  });

  app.get('/api/signal/status', async (_req, res) => {
    const key = process.env.GEMINI_API_KEY;
    const hasKey = !!key && key !== 'MY_GEMINI_API_KEY';
    res.json({ ai: hasKey, model: process.env.GEMINI_MODEL || DEFAULT_MODEL, screenshots: await rasterizerAvailable(), policy: activePolicy });
  });

  // The PNG the AI inspected (manual mode shows it next to the verdict)
  app.get('/api/signal/screenshot/:id', (req, res) => {
    const png = screenshotPng(String(req.params.id));
    if (!png) return res.status(404).json({ status: 'error', msg: 'screenshot not found or expired' });
    res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'private, max-age=300'); res.end(png);
  });

  // Simple in-memory history
  const tradeHistory: any[] = [];
  app.post('/api/history/add', (req, res) => {
    tradeHistory.unshift({ ...req.body, id: Date.now() });
    if (tradeHistory.length > 100) tradeHistory.pop();
    res.json({ status: 'ok' });
  });
  app.get('/api/history', (_req, res) => {
    res.json(tradeHistory);
  });

  const computeKeyLevels = (bars: Cand[]) => {
    const w = bars.slice(-30);
    if (!w.length) return { support: null, resistance: null };
    return {
      support: Math.min(...w.map((c) => c.low)),
      resistance: Math.max(...w.map((c) => c.high)),
    };
  };

  app.post('/api/signal', async (req, res) => {
    try {
      const candles: Cand[] = Array.isArray(req.body?.candles) ? req.body.candles.slice(-600) : [];
      const timing = getGlobalTiming();
      const rawTf = req.body?.tf !== undefined ? Number(req.body.tf) : timing.tfSec;
      const tf = isSupportedTimeframe(rawTf) || rawTf === 30 ? rawTf : timing.tfSec;
      const expirySec = req.body?.expirySec !== undefined && Number(req.body.expirySec) > 0 ? Number(req.body.expirySec) : timing.expirySec;
      const label = String(req.body?.label ?? req.body?.symbol ?? 'this market').slice(0, 40);
      const nowSec = Number.isFinite(Number(req.body?.now)) && Number(req.body?.now) > 1e9 ? Number(req.body.now) : undefined;
      const nowMs = nowSec != null ? nowSec * 1000 : Date.now();
      const closed = candles.length && candles[candles.length - 1].time >= Math.floor(nowMs / 1000 / tf) * tf ? candles.slice(0, -1) : candles;
      const s = await getSignal({ ...liveDeps(port), expirySec }, candles, tf, label, String(req.body?.symbol ?? label), nowSec);
      res.json({ status: 'ok', signal: s, levels: computeKeyLevels(closed), closed: closed.slice(-85) });
    } catch (e) {
      res.json({ status: 'error', msg: (e as Error).message });
    }
  });

  app.post('/api/signal/autoscan', async (req, res) => {
    try {
      const [{ SWEEP_AGENTS, brokerNowSync }, { derivBridge }] = await Promise.all([
        import('./src/sweepWatcher'),
        import('./src/derivBridge'),
      ]);
      const timing = getGlobalTiming();
      const rawTf = req.body?.tf !== undefined ? Number(req.body.tf) : timing.tfSec;
      const tf = isSupportedTimeframe(rawTf) || rawTf === 30 ? rawTf : timing.tfSec;
      const expirySec = req.body?.expirySec !== undefined && Number(req.body.expirySec) > 0 ? Number(req.body.expirySec) : timing.expirySec;
      const nowSec = Number.isFinite(Number(req.body?.now)) && Number(req.body?.now) > 1e9 ? Number(req.body.now) : brokerNowSync();

      const agents = [...SWEEP_AGENTS];
      const candidates: Array<{
        agent: (typeof agents)[number];
        candles: Cand[];
        closed: Cand[];
        engine: EngineResult;
        rankScore: number;
      }> = [];

      const queue = [...agents];
      const worker = async () => {
        while (queue.length) {
          const agent = queue.shift()!;
          try {
            const raw = await derivBridge.getCandles(agent.symbol, tf, 600);
            if (!Array.isArray(raw) || raw.length < 30) continue;
            const candles: Cand[] = raw.map((c: any) => ({
              time: Number(c.time),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
            }));
            const closed = candles.length && candles[candles.length - 1].time + tf > nowSec ? candles.slice(0, -1) : candles;
            if (closed.length < 30) continue;
            const engine = await runEngines(port, candles, tf, nowSec, agent.symbol, expirySec);
            if (!engine.setup || !engine.side) continue;
            const priority = engine.stochRsiSweep ? 300 : engine.agree >= 2 ? 200 : 100;
            const goldBonus = agent.symbol === 'frxXAUUSD' ? 2 : 0;
            candidates.push({
              agent,
              candles,
              closed,
              engine,
              rankScore: priority + engine.confidence + goldBonus,
            });
          } catch {
            // Skip markets unavailable right now without failing the scan
          }
        }
      };

      await Promise.all(Array.from({ length: 6 }, worker));
      candidates.sort((a, b) => b.rankScore - a.rankScore);

      if (candidates.length === 0) {
        return res.json({
          status: 'ok',
          signal: null,
          scannedAgents: agents.length,
          foundCount: 0,
          tf,
          expirySec,
          msg: 'No active Stochastic+RSI+Sweep or price-action setups across all agents on the current closed candle.',
        });
      }

      const base = liveDeps(port);
      const scanPolicy: ExecutionPolicy = {
        ...(base.policy ?? policyFromEnv()),
        maxSignalAgeSec: Math.max(tf, base.policy?.maxSignalAgeSec ?? 60),
      };

      let best: { candidate: (typeof candidates)[number]; signal: Signal } | null = null;
      for (const cand of candidates.slice(0, 4)) {
        const deps: SignalDeps = {
          ...base,
          expirySec,
          policy: scanPolicy,
          engines: async () => cand.engine,
        };
        const sig = await getSignal(deps, cand.candles, tf, cand.agent.market, `deriv:${cand.agent.symbol}`, nowSec);
        if (!best || (sig.tradeable && !best.signal.tradeable)) {
          best = { candidate: cand, signal: sig };
        }
        if (sig.tradeable) break;
      }

      const picked = best!;
      return res.json({
        status: 'ok',
        signal: picked.signal,
        symbol: picked.candidate.agent.symbol,
        market: picked.candidate.agent.market,
        name: picked.candidate.agent.name,
        tf,
        expirySec,
        levels: computeKeyLevels(picked.candidate.closed),
        closed: picked.candidate.closed.slice(-85),
        scannedAgents: agents.length,
        foundCount: candidates.length,
      });
    } catch (e) {
      res.json({ status: 'error', msg: (e as Error).message });
    }
  });
}
