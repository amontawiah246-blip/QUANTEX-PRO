import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createChart, CrosshairMode, IChartApi, ISeriesApi, LineStyle, LogicalRange, UTCTimestamp } from "lightweight-charts";
import { BROKERS, ChartType } from "./assets";
import { computeIndicatorSeries } from "./stochRsiSweep";

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:` : "") + `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
const decimalsFor = (p: number) => (p < 10 ? 5 : p < 1000 ? 3 : 2);

const UP = "#22c55e";
const DOWN = "#ef4444";
const ACCENT = "#4d7cff";
const STO_K_BLUE = "#3b82f6";
const STO_D_ORANGE = "#f97316";
const RSI_LIME = "#a3e635";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Quote {
  price: number | null;
  up: boolean;
  left: number; // seconds left in the forming candle
  dec: number;
  live: boolean;
}

/** What the chart menu can ask the chart to do. A string result is an error message to show the user. */
export interface ChartHandle {
  getQuote: () => Quote;
  screenshot: () => Promise<string | void>;
  fullscreen: () => Promise<string | void>;
}

interface ChartViewProps {
  wsBase: string;
  broker: string;
  asset: string;
  tf: number;
  reloadKey: number;
  chartType: ChartType;
}

const isLine = (t: ChartType) => t === "line" || t === "area" || t === "baseline";

// Heikin Ashi candle from a normal candle and the previous Heikin Ashi candle.
function haNext(c: Candle, prev?: Candle): Candle {
  const close = (c.open + c.high + c.low + c.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (c.open + c.close) / 2;
  return { time: c.time, open, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close), close };
}

const ChartView = forwardRef<ChartHandle, ChartViewProps>(function ChartView({ wsBase, broker, asset, tf, reloadKey, chartType }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const stochBox = useRef<HTMLDivElement>(null);
  const rsiBox = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "live" | "error">("connecting");
  const [msg, setMsg] = useState("");
  const [tickRate, setTickRate] = useState(0);
  const [indReadout, setIndReadout] = useState<{ k: number; d: number; rsi: number }>({ k: 50, d: 50, rsi: 50 });

  const typeRef = useRef<ChartType>(chartType);
  typeRef.current = chartType;
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctl = useRef<{ setType: (t: ChartType) => void; quote: () => Omit<Quote, "live">; shot: () => HTMLCanvasElement } | null>(null);

  useImperativeHandle(ref, () => ({
    getQuote: () => ({ ...(ctl.current?.quote() ?? { price: null, up: true, left: tf, dec: 5 }), live: stateRef.current === "live" }),
    screenshot: async () => {
      const canvas = ctl.current?.shot();
      if (!canvas) return "The chart is not ready yet";
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const name = `quantx-${asset}-${tf}s-${stamp}.png`;
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
      if (!blob) return "Could not create the screenshot";
      try {
        const file = new File([blob], name, { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: name }); // phone share sheet: save to gallery, send, etc.
          return;
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },
    fullscreen: async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        return "Fullscreen is blocked here. Open the app in its own browser tab to use it.";
      }
    },
  }), [tf, asset]);

  useEffect(() => {
    setState("connecting");
    setMsg("");
    if (!box.current || !stochBox.current || !rsiBox.current) return;

    const commonOpts = {
      autoSize: true,
      layout: { background: { color: "#0a1020" }, textColor: "#7d89a8", fontSize: 11 },
      grid: { vertLines: { color: "#111a30" }, horzLines: { color: "#111a30" } },
      crosshair: { mode: CrosshairMode.Normal },
    };

    const chart: IChartApi = createChart(box.current, {
      ...commonOpts,
      rightPriceScale: { borderVisible: false, minimumWidth: 66, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { visible: false, borderVisible: false, timeVisible: true, secondsVisible: tf < 60, rightOffset: 8, barSpacing: 11, minBarSpacing: 3 },
    });

    const stochChart: IChartApi = createChart(stochBox.current, {
      ...commonOpts,
      rightPriceScale: { borderVisible: false, minimumWidth: 66, scaleMargins: { top: 0.14, bottom: 0.1 } },
      timeScale: { visible: false, borderVisible: false, rightOffset: 8, barSpacing: 11, minBarSpacing: 3 },
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: false, mouseWheel: true, pinch: true },
    });

    const rsiChart: IChartApi = createChart(rsiBox.current, {
      ...commonOpts,
      rightPriceScale: { borderVisible: false, minimumWidth: 66, scaleMargins: { top: 0.14, bottom: 0.08 } },
      timeScale: { visible: true, borderVisible: false, timeVisible: true, secondsVisible: tf < 60, rightOffset: 8, barSpacing: 11, minBarSpacing: 3 },
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: false, mouseWheel: true, pinch: true },
    });

    const fixedOscRange = () => ({ priceRange: { minValue: 0, maxValue: 100 } });

    const stochDSeries = stochChart.addLineSeries({
      color: STO_D_ORANGE,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: fixedOscRange,
    });
    const stochKSeries = stochChart.addLineSeries({
      color: STO_K_BLUE,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
      autoscaleInfoProvider: fixedOscRange,
    });
    stochKSeries.createPriceLine({ price: 80, color: "#22c55e", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "" });
    stochKSeries.createPriceLine({ price: 20, color: "#eab308", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "" });

    const rsiSeries = rsiChart.addLineSeries({
      color: RSI_LIME,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
      autoscaleInfoProvider: fixedOscRange,
    });
    rsiSeries.createPriceLine({ price: 70, color: "#22c55e", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "" });
    rsiSeries.createPriceLine({ price: 50, color: "#64748b", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "" });
    rsiSeries.createPriceLine({ price: 30, color: "#eab308", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "" });

    let syncingRange = false;
    const syncRangeFrom = (source: IChartApi, targets: IChartApi[]) => {
      source.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
        if (syncingRange || !range) return;
        syncingRange = true;
        try {
          for (const tgt of targets) tgt.timeScale().setVisibleLogicalRange(range);
        } finally {
          syncingRange = false;
        }
      });
    };
    syncRangeFrom(chart, [stochChart, rsiChart]);
    syncRangeFrom(stochChart, [chart, rsiChart]);
    syncRangeFrom(rsiChart, [chart, stochChart]);

    let cs: Candle[] = [];   // candles exactly as the bridge sent them
    let ha: Candle[] = [];   // Heikin Ashi version, kept in step with cs while that chart type is shown
    let type: ChartType = typeRef.current;
    let last: Candle | null = null;
    let dec: number | null = null;

    const makeSeries = (t: ChartType): ISeriesApi<any> => {
      const common = { lastValueVisible: false, priceLineVisible: false };
      switch (t) {
        case "bars":
          return chart.addBarSeries({ upColor: UP, downColor: DOWN, ...common });
        case "line":
          return chart.addLineSeries({ color: ACCENT, lineWidth: 2, ...common });
        case "area":
          return chart.addAreaSeries({ lineColor: ACCENT, topColor: "rgba(77,124,255,0.35)", bottomColor: "rgba(77,124,255,0)", lineWidth: 2, ...common });
        case "baseline":
          return chart.addBaselineSeries({
            baseValue: { type: "price", price: cs.length ? cs[cs.length - 1].close : 0 },
            topLineColor: UP, bottomLineColor: DOWN,
            topFillColor1: "rgba(34,197,94,0.28)", topFillColor2: "rgba(34,197,94,0.04)",
            bottomFillColor1: "rgba(239,68,68,0.04)", bottomFillColor2: "rgba(239,68,68,0.28)",
            lineWidth: 2, ...common,
          });
        case "hollow": // up candles are outlines, down candles are filled
          return chart.addCandlestickSeries({
            upColor: "rgba(0,0,0,0)", downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
            wickUpColor: UP, wickDownColor: DOWN, borderVisible: true, ...common,
          });
        default:
          return chart.addCandlestickSeries({
            upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false, ...common,
          });
      }
    };

    let series: ISeriesApi<any> = makeSeries(type);

    const shown = (i: number) => (type === "heikin" ? ha[i] : cs[i]);
    const pointFor = (c: Candle) =>
      isLine(type)
        ? { time: c.time as UTCTimestamp, value: c.close }
        : { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };

    const applyPrecision = () => {
      if (dec) series.applyOptions({ priceFormat: { type: "price", precision: dec, minMove: 1 / 10 ** dec } });
    };

    const setPrecision = (p: number) => {
      if (dec) return;
      dec = decimalsFor(p);
      applyPrecision();
    };

    const syncIndicatorsFull = () => {
      if (!cs.length) return;
      const ind = computeIndicatorSeries(cs);
      stochKSeries.setData(cs.map((c, idx) => ({ time: c.time as UTCTimestamp, value: ind.stochK[idx] })));
      stochDSeries.setData(cs.map((c, idx) => ({ time: c.time as UTCTimestamp, value: ind.stochD[idx] })));
      rsiSeries.setData(cs.map((c, idx) => ({ time: c.time as UTCTimestamp, value: ind.rsi[idx] })));
      const tail = cs.length - 1;
      setIndReadout({ k: ind.stochK[tail], d: ind.stochD[tail], rsi: ind.rsi[tail] });
    };

    const syncIndicatorsTip = () => {
      if (!cs.length) return;
      const tailWindow = cs.slice(-180);
      const ind = computeIndicatorSeries(tailWindow);
      const lastBar = tailWindow[tailWindow.length - 1];
      const tailIdx = tailWindow.length - 1;
      const t = lastBar.time as UTCTimestamp;
      stochKSeries.update({ time: t, value: ind.stochK[tailIdx] });
      stochDSeries.update({ time: t, value: ind.stochD[tailIdx] });
      rsiSeries.update({ time: t, value: ind.rsi[tailIdx] });
      setIndReadout({ k: ind.stochK[tailIdx], d: ind.stochD[tailIdx], rsi: ind.rsi[tailIdx] });
    };

    // Draw every candle again (history arrived, or the chart type changed).
    const render = () => {
      if (type === "heikin") {
        ha = [];
        for (let i = 0; i < cs.length; i++) ha.push(haNext(cs[i], ha[i - 1]));
      }
      series.setData(cs.map((_, i) => pointFor(shown(i))));
      if (type === "baseline" && cs.length) series.applyOptions({ baseValue: { type: "price", price: cs[cs.length - 1].close } });
      syncIndicatorsFull();
      last = cs.length ? cs[cs.length - 1] : null;
    };

    // One live candle changed (or a new one opened).
    const applyCandle = (c: Candle) => {
      const n = cs.length;
      if (n && cs[n - 1].time === c.time) cs[n - 1] = c;
      else if (!n || c.time > cs[n - 1].time) cs.push(c);
      else return;
      const i = cs.length - 1;
      if (type === "heikin") ha[i] = haNext(cs[i], ha[i - 1]);
      series.update(pointFor(shown(i)));
      syncIndicatorsTip();
      last = c;
    };

    let ticks = 0;
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const place = () => {
      const el = pill.current;
      if (!el || !last) return;
      const y = series.priceToCoordinate(last.close);
      if (y == null) { el.style.display = "none"; return; }
      const left = tf - (Math.floor(Date.now() / 1000) % tf);
      el.style.display = "flex";
      el.style.top = `${y}px`;
      el.dataset.up = last.close >= last.open ? "1" : "0";
      if (el.children[0]) el.children[0].textContent = clock(left);
      if (el.children[1]) el.children[1].textContent = last.close.toFixed(dec ?? 5);
    };

    const setType = (t: ChartType) => {
      if (t === type) return;
      chart.removeSeries(series);
      type = t;
      series = makeSeries(t);
      applyPrecision();
      render();
      place();
    };

    ctl.current = {
      setType,
      quote: () => ({
        price: last ? last.close : null,
        up: last ? last.close >= last.open : true,
        left: tf - (Math.floor(Date.now() / 1000) % tf),
        dec: dec ?? 5,
      }),
      shot: () => {
        const cMain = chart.takeScreenshot();
        const cSto = stochChart.takeScreenshot();
        const cRsi = rsiChart.takeScreenshot();
        const out = document.createElement("canvas");
        out.width = Math.max(cMain.width, cSto.width, cRsi.width);
        out.height = cMain.height + cSto.height + cRsi.height;
        const ctx = out.getContext("2d");
        if (!ctx) return cMain;
        ctx.fillStyle = "#0a1020";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(cMain, 0, 0);
        ctx.drawImage(cSto, 0, cMain.height);
        ctx.drawImage(cRsi, 0, cMain.height + cSto.height);
        return out;
      },
    };

    const ticker = setInterval(place, 250);
    const meter = setInterval(() => { setTickRate(ticks); ticks = 0; }, 1000);

    const open = () => {
      try {
        ws = new WebSocket(`${wsBase}/ws?broker=${encodeURIComponent(broker)}&asset=${encodeURIComponent(asset)}&tf=${tf}`);
        ws.onmessage = (e) => {
          if (closed) return; // a late message from the broker we just left must never paint on the new chart
          try {
            const m = JSON.parse(e.data);
            if (m.type === "history" && Array.isArray(m.candles) && m.candles.length) {
              // A refresh must never take away candles the chart already shows (that is how holes appeared).
              if (m.resync && last && m.candles[m.candles.length - 1].time < last.time) return;
              setPrecision(m.candles[m.candles.length - 1].close);
              cs = m.candles.map((c: Candle) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
              render();
              if (!m.resync) {
                const len = cs.length;
                const rng = { from: len - 35, to: len + 4 };
                chart.timeScale().setVisibleLogicalRange(rng);
                stochChart.timeScale().setVisibleLogicalRange(rng);
                rsiChart.timeScale().setVisibleLogicalRange(rng);
              }
              setState("live");
              place();
            } else if (m.type === "tick") {
              setPrecision(m.price);
              if (last && m.candle.time < last.time) return; // stale tick for a candle that already closed
              applyCandle(m.candle);
              ticks++;
              setState("live");
              place();
            } else if (m.type === "error") {
              setState("error");
              setMsg(m.msg);
            } else if (m.type === "info") {
              setMsg(m.msg);
            }
          } catch {
            // ignore parsing error
          }
        };

        ws.onclose = () => {
          if (!closed) {
            setState("connecting");
            retry = setTimeout(open, 3000);
          }
        };

        ws.onerror = () => {
          if (!closed) {
            setState("connecting");
          }
        };
      } catch {
        if (!closed) {
          setState("connecting");
          retry = setTimeout(open, 3000);
        }
      }
    };

    open();

    return () => {
      closed = true;
      ctl.current = null;
      clearTimeout(retry);
      clearInterval(ticker);
      clearInterval(meter);
      if (ws) ws.close();
      chart.remove();
      stochChart.remove();
      rsiChart.remove();
    };
  }, [wsBase, broker, asset, tf, reloadKey]);

  // Switching the chart type keeps the data and the connection; only the drawing changes.
  useEffect(() => { ctl.current?.setType(chartType); }, [chartType]);

  return (
    <div className="chart-wrap">
      <div className="chart-main">
        <div ref={box} className="chart" />
        <div ref={pill} className="pill" style={{ display: "none" }}><span /><span /></div>
        {state === "live" && (
          <div className="rate" style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <span>{tickRate} updates/s</span>
            <span style={{ color: "#7d89a8", borderLeft: "1px solid #1e293b", paddingLeft: "8px" }}>
              {new Date().toISOString().substring(11, 19)} UTC+0
            </span>
          </div>
        )}
      </div>

      <div className="ind-pane">
        <div className="ind-lbl">
          <span>Stochastic Oscillator 14 3 3</span>
          <span style={{ color: STO_K_BLUE }}>%K {indReadout.k.toFixed(1)}</span>
          <span style={{ color: STO_D_ORANGE }}>%D {indReadout.d.toFixed(1)}</span>
        </div>
        <div ref={stochBox} className="chart" />
      </div>

      <div className="ind-pane rsi">
        <div className="ind-lbl">
          <span>RSI 14</span>
          <span style={{ color: RSI_LIME }}>{indReadout.rsi.toFixed(1)}</span>
        </div>
        <div ref={rsiBox} className="chart" />
      </div>

      {state !== "live" && (
        <div className="overlay">
          <b>{state === "error" ? "Bridge error" : "Waiting for live data"}</b>
          <span>{msg || `Connecting to ${BROKERS.find((b) => b.id === broker)?.name || broker}...`}</span>
        </div>
      )}
    </div>
  );
});

export default ChartView;
