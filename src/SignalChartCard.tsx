import React, { useEffect, useMemo, useState } from "react";
import { ema, levels as findLevels } from "./analysis";
import { computeIndicatorSeries } from "./stochRsiSweep";
import { Side, summarize, TradeRec } from "./tradeSession";

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SignalChartCardProps {
  http: string;
  symbol: string;
  label: string;
  payout: string;
  tfSec: number;
  expirySec: number;
  side: Side;
  signal: any;
  initialCandles: ChartCandle[];
  levels?: { support?: number | null; resistance?: number | null } | null;
  mtgStep: number;
  recs: TradeRec[];
  activeTrade: TradeRec | null;
}

const fmtPrice = (v: number) => {
  if (!Number.isFinite(v)) return "—";
  const dec = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 100 ? 3 : Math.abs(v) >= 10 ? 4 : 5;
  return v.toFixed(dec);
};

const fmtUtc = (sec: number) => {
  const d = new Date(sec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
};

export default function SignalChartCard({
  http,
  symbol,
  label,
  payout,
  tfSec,
  expirySec,
  side,
  signal,
  initialCandles,
  levels,
  mtgStep,
  recs,
  activeTrade,
}: SignalChartCardProps) {
  const [liveCandles, setLiveCandles] = useState<ChartCandle[]>(initialCandles);
  const [viewMode, setViewMode] = useState<"live" | "snapshot">("live");
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    setLiveCandles(initialCandles);
  }, [initialCandles, symbol, tfSec]);

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (viewMode !== "live" || !symbol || !http) return;
    let dead = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `${http}/api/deriv/synthetic-candles?symbol=${encodeURIComponent(symbol)}&tf=${tfSec}&count=85`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!dead && Array.isArray(data.candles) && data.candles.length >= 16) {
          setLiveCandles(data.candles);
        }
      } catch {
        /* ignore background refresh failure */
      }
    };
    const timer = setInterval(poll, 3000);
    return () => {
      dead = true;
      clearInterval(timer);
    };
  }, [http, symbol, tfSec, viewMode]);

  const candles = useMemo(() => {
    const src = viewMode === "snapshot" && initialCandles.length >= 16 ? initialCandles : liveCandles;
    return src.slice(-85);
  }, [viewMode, initialCandles, liveCandles]);

  const computed = useMemo(() => {
    if (candles.length < 2) {
      return {
        shown: candles,
        e9: [] as number[],
        e21: [] as number[],
        e50: [] as number[],
        rsi: [] as number[],
        stochK: [] as number[],
        stochD: [] as number[],
        support: levels?.support ?? null,
        resistance: levels?.resistance ?? null,
      };
    }
    const closes = candles.map((c) => c.close);
    const e9All = ema(closes, 9);
    const e21All = ema(closes, 21);
    const e50All = ema(closes, 50);
    const ind = computeIndicatorSeries(candles);
    const visible = Math.min(48, candles.length);
    const offset = candles.length - visible;
    const piv = findLevels(candles.slice(0, -1), Math.min(60, candles.length - 1));
    const curPrice = closes[closes.length - 1];
    const supBelow = piv.lows.filter((v) => v <= curPrice);
    const resAbove = piv.highs.filter((v) => v >= curPrice);
    const fallbackSup = supBelow.length ? Math.max(...supBelow) : piv.lows.length ? piv.lows[piv.lows.length - 1] : null;
    const fallbackRes = resAbove.length ? Math.min(...resAbove) : piv.highs.length ? piv.highs[piv.highs.length - 1] : null;

    return {
      shown: candles.slice(offset),
      e9: e9All.slice(offset),
      e21: e21All.slice(offset),
      e50: e50All.slice(offset),
      rsi: ind.rsi.slice(offset),
      stochK: ind.stochK.slice(offset),
      stochD: ind.stochD.slice(offset),
      support: levels?.support ?? fallbackSup,
      resistance: levels?.resistance ?? fallbackRes,
    };
  }, [candles, levels]);

  const summary = useMemo(() => summarize(recs), [recs]);
  const isBuy = side === "buy";
  const confidence = signal?.verification?.aiConfidence ?? signal?.confidence ?? 0;

  const entryTimeSec = activeTrade
    ? Math.floor(activeTrade.ts / 1000)
    : computed.shown.length
      ? computed.shown[computed.shown.length - 1].time + tfSec
      : nowSec;
  const expiryTimeSec = entryTimeSec + (activeTrade?.seconds ?? expirySec);
  const remainingSec = Math.max(0, expiryTimeSec - nowSec);

  const curK = computed.stochK.at(-1) ?? 50;
  const curD = computed.stochD.at(-1) ?? 50;
  const curRsi = computed.rsi.at(-1) ?? 50;
  const latestCandle = computed.shown.at(-1);

  // SVG layout coordinates (3 synchronized panes)
  const W = 760;
  const H = 500;
  const L = 12;
  const R = 692;
  const T = 14;
  const B = 248;
  const STO_T = 266;
  const STO_B = 362;
  const RSI_T = 382;
  const RSI_B = 472;

  const n = computed.shown.length;
  const slots = Math.max(n + 2, 10);
  const slot = (R - L) / slots;
  const bw = Math.max(3, Math.min(11, slot * 0.58));
  const x = (i: number) => L + slot * (i + 0.5);

  let lo = n ? Math.min(...computed.shown.map((c) => c.low)) : 0;
  let hi = n ? Math.max(...computed.shown.map((c) => c.high)) : 1;
  if (computed.support != null) lo = Math.min(lo, computed.support);
  if (computed.resistance != null) hi = Math.max(hi, computed.resistance);
  const span = Math.max(hi - lo, Math.abs(hi) * 1e-6, 1e-9);
  const ymin = lo - span * 0.1;
  const ymax = hi + span * 0.1;
  const y = (p: number) => B - ((p - ymin) / (ymax - ymin)) * (B - T);
  const ySto = (v: number) => STO_B - (Math.max(0, Math.min(100, v)) / 100) * (STO_B - STO_T);
  const yRsi = (v: number) => RSI_B - (Math.max(0, Math.min(100, v)) / 100) * (RSI_B - RSI_T);

  const polylinePts = (vals: number[], yFn: (v: number) => number) =>
    vals.map((v, idx) => `${x(idx).toFixed(1)},${yFn(v).toFixed(1)}`).join(" ");

  const entryMarkerX = n ? x(n - 1) + slot * 0.5 : R - 30;

  return (
    <div className="mt-4 rounded-2xl border border-cyan-500/25 bg-[#070f24] p-3 text-slate-100 shadow-xl">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-lg px-2.5 py-0.5 text-xs font-extrabold tracking-wide ${
              isBuy
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                : "bg-rose-500/20 text-rose-300 border border-rose-500/40"
            }`}
          >
            {isBuy ? "BUY" : "SELL"}
          </span>
          <span className="text-sm font-bold text-white">{label}</span>
          <span className="text-xs text-slate-400 font-mono">
            {tfSec < 60 ? `${tfSec}s` : `${Math.round(tfSec / 60)}m`} · Exp {expirySec}s
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setViewMode("live")}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
              viewMode === "live"
                ? "bg-cyan-500/25 text-cyan-200 border border-cyan-400/50"
                : "bg-slate-900 text-slate-400 border border-slate-800 hover:text-slate-200"
            }`}
          >
            Live View
          </button>
          <button
            type="button"
            onClick={() => setViewMode("snapshot")}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
              viewMode === "snapshot"
                ? "bg-indigo-500/25 text-indigo-200 border border-indigo-400/50"
                : "bg-slate-900 text-slate-400 border border-slate-800 hover:text-slate-200"
            }`}
          >
            Snapshot
          </button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_210px]">
        <div className="overflow-hidden rounded-xl border border-slate-800/90 bg-[#050b1b]">
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full select-none">
            <rect width={W} height={H} fill="#050b1b" />

            {/* Price horizontal grid */}
            {[0, 0.25, 0.5, 0.75, 1].map((frac, idx) => {
              const p = ymin + (ymax - ymin) * frac;
              const yy = y(p);
              return (
                <g key={idx}>
                  <line x1={L} y1={yy} x2={R} y2={yy} stroke="#131f3b" strokeDasharray="4 4" strokeWidth={1} />
                  <text x={R + 6} y={yy + 3.5} fill="#7d89a8" fontSize={10} fontFamily="monospace">
                    {fmtPrice(p)}
                  </text>
                </g>
              );
            })}

            {/* Support & Resistance levels */}
            {computed.support != null && (
              <g>
                <line
                  x1={L}
                  y1={y(computed.support)}
                  x2={R}
                  y2={y(computed.support)}
                  stroke="#22c55e"
                  strokeWidth={1.2}
                  strokeDasharray="5 4"
                  opacity={0.75}
                />
                <text x={L + 4} y={y(computed.support) - 4} fill="#4ade80" fontSize={9.5} fontWeight="700">
                  SUP {fmtPrice(computed.support)}
                </text>
              </g>
            )}
            {computed.resistance != null && (
              <g>
                <line
                  x1={L}
                  y1={y(computed.resistance)}
                  x2={R}
                  y2={y(computed.resistance)}
                  stroke="#ef4444"
                  strokeWidth={1.2}
                  strokeDasharray="5 4"
                  opacity={0.75}
                />
                <text x={L + 4} y={y(computed.resistance) - 4} fill="#f87171" fontSize={9.5} fontWeight="700">
                  RES {fmtPrice(computed.resistance)}
                </text>
              </g>
            )}

            {/* EMA 9 / 21 / 50 overlays */}
            {n > 1 && (
              <>
                <polyline fill="none" stroke="#f59e0b" strokeWidth={1.4} opacity={0.85} points={polylinePts(computed.e9, y)} />
                <polyline fill="none" stroke="#38bdf8" strokeWidth={1.4} opacity={0.85} points={polylinePts(computed.e21, y)} />
                <polyline fill="none" stroke="#a855f7" strokeWidth={1.3} opacity={0.7} points={polylinePts(computed.e50, y)} />
              </>
            )}

            {/* Candlesticks */}
            {computed.shown.map((c, idx) => {
              const cx = x(idx);
              const up = c.close >= c.open;
              const col = up ? "#22c55e" : "#ef4444";
              const top = y(Math.max(c.open, c.close));
              const bot = y(Math.min(c.open, c.close));
              return (
                <g key={`${c.time}-${idx}`}>
                  <line x1={cx} y1={y(c.high)} x2={cx} y2={y(c.low)} stroke={col} strokeWidth={1.6} />
                  <rect
                    x={cx - bw / 2}
                    y={top}
                    width={bw}
                    height={Math.max(1.8, bot - top)}
                    fill={col}
                    rx={0.8}
                  />
                </g>
              );
            })}

            {/* Current Price Line */}
            {latestCandle && (
              <g>
                <line
                  x1={L}
                  y1={y(latestCandle.close)}
                  x2={R}
                  y2={y(latestCandle.close)}
                  stroke="#3b82f6"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                  opacity={0.8}
                />
                <rect x={R + 2} y={y(latestCandle.close) - 9} width={64} height={18} rx={4} fill="#2563eb" />
                <text x={R + 34} y={y(latestCandle.close) + 3.5} fill="#fff" fontSize={10} fontWeight="700" textAnchor="middle" fontFamily="monospace">
                  {fmtPrice(latestCandle.close)}
                </text>
              </g>
            )}

            {/* Entry & Settlement Status Marker */}
            {n > 0 && (
              <g>
                <line
                  x1={entryMarkerX}
                  y1={T}
                  x2={entryMarkerX}
                  y2={RSI_B}
                  stroke={isBuy ? "#22c55e" : "#ef4444"}
                  strokeWidth={1.2}
                  strokeDasharray="3 3"
                  opacity={0.7}
                />
                <rect
                  x={entryMarkerX - 24}
                  y={T + 2}
                  width={48}
                  height={16}
                  rx={4}
                  fill={isBuy ? "#14532d" : "#7f1d1d"}
                  stroke={isBuy ? "#22c55e" : "#ef4444"}
                  strokeWidth={1}
                />
                <text x={entryMarkerX} y={T + 13} fill="#fff" fontSize={9.5} fontWeight="800" textAnchor="middle">
                  {activeTrade?.result === "win"
                    ? "WIN"
                    : activeTrade?.result === "loss"
                      ? "LOSS"
                      : isBuy
                        ? "BUY"
                        : "SELL"}
                </text>
              </g>
            )}

            {/* Legend on top left */}
            <text x={L + 4} y={T + 11} fill="#94a3b8" fontSize={10} fontWeight="600">
              <tspan fill="#f59e0b">EMA9</tspan> · <tspan fill="#38bdf8">EMA21</tspan> · <tspan fill="#a855f7">EMA50</tspan>
            </text>

            {/* Panel 2: Stochastic Oscillator 14 3 3 (blue %K, solid orange %D, 80 green / 20 yellow) */}
            <rect x={L} y={STO_T} width={R - L} height={STO_B - STO_T} fill="#071028" stroke="#182445" strokeWidth={1} />
            <line x1={L} y1={ySto(80)} x2={R} y2={ySto(80)} stroke="#22c55e" strokeWidth={1.1} opacity={0.75} />
            <text x={R + 6} y={ySto(80) + 3.5} fill="#94a3b8" fontSize={10} fontFamily="monospace">80</text>
            <line x1={L} y1={ySto(20)} x2={R} y2={ySto(20)} stroke="#eab308" strokeWidth={1.1} opacity={0.75} />
            <text x={R + 6} y={ySto(20) + 3.5} fill="#94a3b8" fontSize={10} fontFamily="monospace">20</text>
            {n > 1 && (
              <>
                <polyline fill="none" stroke="#f97316" strokeWidth={1.8} points={polylinePts(computed.stochD, ySto)} />
                <polyline fill="none" stroke="#3b82f6" strokeWidth={2} points={polylinePts(computed.stochK, ySto)} />
                <circle cx={x(n - 1)} cy={ySto(curK)} r={3} fill="#3b82f6" />
              </>
            )}
            <text x={L + 6} y={STO_T + 13} fill="#e2e8f0" fontSize={10.5} fontWeight="700">
              Stochastic Oscillator 14 3 3{" "}
              <tspan fill="#3b82f6">%K {curK.toFixed(1)}</tspan>{" "}
              <tspan fill="#f97316">%D {curD.toFixed(1)}</tspan>
            </text>

            {/* Panel 3: RSI 14 (lime line, 70 green / 50 slate / 30 yellow) */}
            <rect x={L} y={RSI_T} width={R - L} height={RSI_B - RSI_T} fill="#071028" stroke="#182445" strokeWidth={1} />
            <line x1={L} y1={yRsi(70)} x2={R} y2={yRsi(70)} stroke="#22c55e" strokeWidth={1} opacity={0.7} />
            <text x={R + 6} y={yRsi(70) + 3.5} fill="#94a3b8" fontSize={10} fontFamily="monospace">70</text>
            <line x1={L} y1={yRsi(50)} x2={R} y2={yRsi(50)} stroke="#64748b" strokeWidth={1} opacity={0.65} />
            <text x={R + 6} y={yRsi(50) + 3.5} fill="#94a3b8" fontSize={10} fontFamily="monospace">50</text>
            <line x1={L} y1={yRsi(30)} x2={R} y2={yRsi(30)} stroke="#eab308" strokeWidth={1} opacity={0.7} />
            <text x={R + 6} y={yRsi(30) + 3.5} fill="#94a3b8" fontSize={10} fontFamily="monospace">30</text>
            {n > 1 && (
              <>
                <polyline fill="none" stroke="#a3e635" strokeWidth={1.9} points={polylinePts(computed.rsi, yRsi)} />
                <circle cx={x(n - 1)} cy={yRsi(curRsi)} r={3} fill="#a3e635" />
              </>
            )}
            <text x={L + 6} y={RSI_T + 13} fill="#e2e8f0" fontSize={10.5} fontWeight="700">
              RSI 14 <tspan fill="#a3e635">{curRsi.toFixed(1)}</tspan>
            </text>

            {/* Time axis */}
            {n > 0 &&
              [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1]
                .filter((v, idx, arr) => arr.indexOf(v) === idx && v >= 0 && v < n)
                .map((idx) => (
                  <text key={idx} x={x(idx)} y={H - 8} fill="#64748b" fontSize={10} textAnchor="middle" fontFamily="monospace">
                    {fmtUtc(computed.shown[idx].time).slice(0, 5)}
                  </text>
                ))}
          </svg>
        </div>

        {/* Signal Details Sidebar */}
        <div className="flex flex-col gap-2 rounded-xl border border-slate-800/90 bg-[#09132c] p-3 text-xs">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <span className="font-bold tracking-wider text-cyan-300 uppercase text-[11px]">Signal Details</span>
            <span className="font-mono font-bold text-white">{confidence}%</span>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <div className="rounded-lg bg-slate-900/80 p-2">
              <div className="text-[10px] text-slate-400">PAYOUT</div>
              <div className="font-bold text-emerald-400">{payout}</div>
            </div>
            <div className="rounded-lg bg-slate-900/80 p-2">
              <div className="text-[10px] text-slate-400">MTG</div>
              <div className="font-bold text-white">{mtgStep > 0 ? `${mtgStep} Steps` : "None"}</div>
            </div>
            <div className="rounded-lg bg-slate-900/80 p-2">
              <div className="text-[10px] text-slate-400">ENTRY TIME</div>
              <div className="font-mono font-semibold text-slate-100">{fmtUtc(entryTimeSec)}</div>
            </div>
            <div className="rounded-lg bg-slate-900/80 p-2">
              <div className="text-[10px] text-slate-400">STATUS</div>
              <div
                className={`font-bold ${
                  activeTrade?.result === "win"
                    ? "text-emerald-400"
                    : activeTrade?.result === "loss"
                      ? "text-rose-400"
                      : "text-cyan-300"
                }`}
              >
                {activeTrade
                  ? activeTrade.result === "pending"
                    ? `${remainingSec}s left`
                    : activeTrade.result.toUpperCase()
                  : "READY"}
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-slate-900/80 p-2">
            <div className="mb-1 text-[10px] font-semibold text-slate-400">OSCILLATORS</div>
            <div className="flex justify-between font-mono text-[11px]">
              <span className="text-blue-400">%K {curK.toFixed(1)}</span>
              <span className="text-orange-400">%D {curD.toFixed(1)}</span>
              <span className="text-lime-400">RSI {curRsi.toFixed(1)}</span>
            </div>
          </div>

          <div className="rounded-lg bg-slate-900/80 p-2">
            <div className="mb-1 text-[10px] font-semibold text-slate-400">KEY LEVELS</div>
            <div className="flex justify-between font-mono text-[11px]">
              <span className="text-emerald-400">S: {computed.support != null ? fmtPrice(computed.support) : "—"}</span>
              <span className="text-rose-400">R: {computed.resistance != null ? fmtPrice(computed.resistance) : "—"}</span>
            </div>
          </div>

          <div className="rounded-lg bg-slate-900/80 p-2">
            <div className="mb-1 text-[10px] font-semibold text-slate-400">SESSION STATS</div>
            <div className="flex justify-between text-[11px]">
              <span className="text-emerald-400 font-bold">{summary.wins}W</span>
              <span className="text-rose-400 font-bold">{summary.losses}L</span>
              <span className="text-slate-200 font-bold">{summary.winRate}% WR</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
