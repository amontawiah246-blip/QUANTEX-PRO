// Classic mode: pick a Deriv synthetic market from the grid, set time frame / expiry / MTG, then Generate Signal.
// With Auto on, the trade is placed the moment a verified signal arrives and followed (with MTG recovery) to its result.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowLeft, ArrowUp, Clock, Percent, Radar, RefreshCw, Search, ShieldAlert, Square, Star } from "lucide-react";
import { apiFetch } from "./api";
import { Asset, groupOf, iconOf, prettyName, splitName } from "./assets";
import { mtgPlan, MTG_DEFAULT_MULT, Side, summarize, TradeRec } from "./tradeSession";
import { fetchCandles, runChain } from "./classicTrader";
import { StatTiles, TradeList } from "./TradeStats";
import { BROKER_EXPIRY_OPTIONS, BROKER_TIMEFRAME_OPTIONS } from "./globalConfig";
import { useGlobalTiming } from "./useGlobalTiming";
import SignalChartCard, { ChartCandle } from "./SignalChartCard";

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beep = (up: boolean) => {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "sine"; o.frequency.value = up ? 880 : 520; g.gain.value = 0.06; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.16);
    setTimeout(() => ctx.close(), 400);
  } catch { /* no audio */ }
};

const MULTS = [2, MTG_DEFAULT_MULT, 2.5];
const STEPS = ["Calling all 31 market agents", "Stochastic(14,3,3) + RSI(14) crossover check", "Lookback wick sweep & pattern confirmation", "Capturing indicator chart screenshot", "Gemini Vision verification"];
const GROUPS = [
  { id: "all", label: "All" }, { id: "gold", label: "Gold (XAUUSD)" }, { id: "fav", label: "Favorites" }, { id: "1s", label: "1s Volatility" }, { id: "vol", label: "Volatility" },
  { id: "crash_boom", label: "Crash & Boom" }, { id: "jump_step", label: "Jump & Step" },
] as const;
type Grp = (typeof GROUPS)[number]["id"];

/** Gold first (requested focus pair), then Volatility, 1-second ones, Boom, Crash, Jump, Step, the rest. */
const rank = (a: Asset) => {
  const s = a.symbol.toUpperCase();
  return s.includes("XAU") || s.includes("GOLD") ? -1 : s.startsWith("R_") ? 0 : s.startsWith("1HZ") ? 1 : s.startsWith("BOOM") ? 2 : s.startsWith("CRASH") ? 3 : s.startsWith("JD") ? 4 : s.startsWith("STP") || s.startsWith("RB") ? 5 : 6;
};

function SynthIcon({ asset, size = 54 }: { asset: Asset; size?: number }) {
  const ic = iconOf(asset);
  if (ic.kind !== "coin") return null;
  const one = asset.symbol.toUpperCase().startsWith("1HZ");
  const isGold = asset.symbol === "frxXAUUSD" || asset.symbol.toUpperCase().includes("XAU");
  return (
    <span className="qm-ico" style={{ width: size, height: size, ["--c" as string]: isGold ? "#eab308" : ic.color, fontSize: size * (ic.text.length > 3 ? 0.26 : ic.text.length > 2 ? 0.32 : 0.4) }}>
      {isGold ? "XAU" : ic.text}
      {one && <i>1s</i>}
      {isGold && <i>Au</i>}
    </span>
  );
}

interface Props {
  http: string; wsBase: string; assets: Asset[]; asset: string; setAsset: (s: string) => void;
  balance?: number | null; isDemo?: boolean; ready: boolean; onToast: (m: string) => void; onExit: () => void;
}

export default function ClassicMode({ http, wsBase, assets, asset, setAsset, balance, isDemo, ready, onToast, onExit }: Props) {
  const { timing, updateTiming } = useGlobalTiming(http);
  const tf = timing.tfSec;
  const expiry = timing.expirySec;

  const [view, setView] = useState<"pairs" | "setup">("setup");
  const [scanAll, setScanAll] = useState<boolean>(true);
  const [q, setQ] = useState("");
  const [grp, setGrp] = useState<Grp>("all");
  const [favs, setFavs] = useState<string[]>(() => store.get("qx-fav-deriv", []));

  const [mtgStep, setMtgStep] = useState<number>(() => store.get("qx-cl-mtg", 2));
  const [mult, setMult] = useState<number>(() => store.get("qx-cl-mult", MTG_DEFAULT_MULT));
  const [auto, setAuto] = useState<boolean>(() => store.get("qx-cl-auto", false));
  const [stake, setStake] = useState<string>(() => String(store.get("qx-cl-stake", 10)));
  useEffect(() => { store.set("qx-cl-mtg", mtgStep); store.set("qx-cl-mult", mult); store.set("qx-cl-auto", auto); }, [mtgStep, mult, auto]);

  const [phase, setPhase] = useState<"idle" | "analyzing" | "done">("idle");
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [sg, setSg] = useState<any>(null);
  const [scanMeta, setScanMeta] = useState<{ symbol: string; market: string; scannedAgents?: number; foundCount?: number } | null>(null);
  const [chartCandles, setChartCandles] = useState<ChartCandle[]>([]);
  const [chartLevels, setChartLevels] = useState<{ support?: number | null; resistance?: number | null } | null>(null);
  const [none, setNone] = useState("");
  const [trading, setTrading] = useState(false);
  const [recs, setRecs] = useState<TradeRec[]>(() => store.get("qx-classic-trades", []));
  const [now, setNow] = useState(() => Date.now());

  const runId = useRef(0);
  const cancel = useRef(false);
  const alive = useRef(true);
  const reported = useRef(new Set<string>());
  const balRef = useRef(balance ?? null); balRef.current = balance ?? null;
  const realOk = useRef(false);

  useEffect(() => { alive.current = true; const id = setInterval(() => setNow(Date.now()), 1000); return () => { alive.current = false; clearInterval(id); runId.current++; cancel.current = true; }; }, []);

  const stakeNum = Math.max(0, parseFloat(stake) || 0);
  const plan = mtgPlan(stakeNum, { on: mtgStep > 0, steps: mtgStep, mult });
  const summary = useMemo(() => summarize(recs), [recs]);

  // ---- trade records (saved on this device, and every finished trade is added to the Account history)
  const upsert = useCallback((r: TradeRec) => {
    setRecs((cur) => {
      const i = cur.findIndex((x) => x.id === r.id);
      const next = (i >= 0 ? cur.map((x) => (x.id === r.id ? r : x)) : [r, ...cur]).slice(0, 100);
      store.set("qx-classic-trades", next);
      return next;
    });
    if ((r.result === "win" || r.result === "loss") && !reported.current.has(r.id)) {
      reported.current.add(r.id);
      fetch(`${http}/api/history/add`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market: r.label, side: r.side, result: r.result, profit: r.profit, time: Date.now() }) }).catch(() => {});
    }
  }, [http]);

  // a trade that was still running when the app was closed: ask the broker what happened to it
  useEffect(() => {
    const stale = recs.filter((r) => r.result === "pending" && r.contract && Date.now() > r.ts + r.seconds * 1000);
    stale.forEach(async (r) => {
      try {
        const d = await (await fetch(`${http}/api/trade-result?broker=deriv&id=${encodeURIComponent(r.contract!)}&seconds=20`)).json();
        if (d.status === "ok" && ["win", "loss", "draw"].includes(d.result)) upsert({ ...r, result: d.result, profit: d.profit ?? null });
        else upsert({ ...r, result: "error", note: "result not found" });
      } catch { /* try again next time */ }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const synth = useMemo(() => assets.filter((a) => groupOf(a) === "Derived Indices" || a.symbol === "frxXAUUSD" || a.symbol.toUpperCase().includes("XAU")), [assets]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/[\s/_-]/g, "");
    return synth.filter((a) => {
      const s = a.symbol.toUpperCase();
      if (grp === "gold") return s.includes("XAU") || s.includes("GOLD");
      if (grp === "fav") return favs.includes(a.symbol);
      if (grp === "1s") return s.startsWith("1HZ");
      if (grp === "vol") return s.startsWith("R_");
      if (grp === "crash_boom") return s.startsWith("BOOM") || s.startsWith("CRASH");
      if (grp === "jump_step") return s.startsWith("JD") || s.startsWith("STP") || s.startsWith("RB") || s.startsWith("RD");
      return true;
    }).filter((a) => !needle || (prettyName(a) + a.symbol).toLowerCase().replace(/[\s/_-]/g, "").includes(needle))
      .sort((x, y) => rank(x) - rank(y) || prettyName(x).localeCompare(prettyName(y), undefined, { numeric: true }));
  }, [synth, q, grp, favs]);

  const toggleFav = (sym: string) => setFavs((cur) => { const n = cur.includes(sym) ? cur.filter((s) => s !== sym) : [...cur, sym]; store.set("qx-fav-deriv", n); return n; });

  const effectiveSymbol = scanMeta?.symbol ?? asset;
  const current = assets.find((a) => a.symbol === effectiveSymbol) ?? assets.find((a) => a.symbol === asset);
  const cur: Asset = current ?? { symbol: effectiveSymbol };
  const { label: splitLabel } = splitName(cur);
  const marketLabel = scanMeta?.market ?? splitLabel;
  const tfOpt = BROKER_TIMEFRAME_OPTIONS.find((t) => t.sec === tf) ?? BROKER_TIMEFRAME_OPTIONS[0];
  const payout = current?.payout && current.payout > 0 ? `${current.payout}%` : "92%";
  const pickedAuto = (_s?: any) => ({ expiry, why: "global central expiry" });

  // ---- place the trade (and its MTG recovery chain) for a signal
  const trade = async (s: any, symOverride?: string, labelOverride?: string) => {
    if (trading) return;
    if (timing.transitioning) { onToast("Agents are synchronizing to the new timeframe — please wait."); return; }
    const side = s.side as Side;
    const sym = symOverride ?? effectiveSymbol;
    const label = labelOverride ?? marketLabel;
    if (!(stakeNum > 0)) { onToast("Enter a stake first"); return; }
    if (isDemo === false && !realOk.current) {
      if (!window.confirm(`REAL account: this places a real-money ${side.toUpperCase()} on ${label}${mtgStep ? ` and up to ${mtgStep} MTG recovery steps (worst case $${plan.worstCase.toFixed(2)})` : ""}. Continue?`)) return;
      realOk.current = true;
    }
    const picked = pickedAuto(s);
    setTrading(true); cancel.current = false;
    onToast(`Placing ${side.toUpperCase()} on ${label} · $${stakeNum} · ${picked.expiry}s`);
    const targetAsset = assets.find((a) => a.symbol === sym);
    const out = await runChain({
      place: async (sd, amount, secs) => {
        const r = await apiFetch(`${http}/api/trade`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broker: "deriv", asset: sym, side: sd, amount, seconds: secs }) });
        const d = await r.json();
        return { ok: d.status === "ok" && !!d.id, msg: d.msg || "", id: d.id ? String(d.id) : undefined };
      },
      result: async (id, secs) => {
        await sleep(secs * 1000 + 800);                                   // let the trade run out first
        for (let i = 0; i < 3 && alive.current; i++) {
          try {
            const d = await (await fetch(`${http}/api/trade-result?broker=deriv&id=${encodeURIComponent(id)}&seconds=90`)).json();
            if (d.status === "ok" && ["win", "loss", "draw"].includes(d.result)) { beep(d.result === "win"); return { outcome: d.result, profit: typeof d.profit === "number" ? d.profit : null }; }
          } catch { /* retry */ }
        }
        return null;
      },
      onRec: (r) => { if (alive.current) upsert(r); else store.set("qx-classic-trades", [r, ...store.get<TradeRec[]>("qx-classic-trades", []).filter((x) => x.id !== r.id)]); },
      balance: () => balRef.current,
      cancelled: () => cancel.current,
    }, { symbol: sym, label, side, stake: stakeNum, seconds: picked.expiry, tf, mtg: { on: mtgStep > 0, steps: mtgStep, mult }, payout: targetAsset?.payout });
    if (!alive.current) return;
    setTrading(false);
    if (out.final === "win") onToast(`WIN ${out.steps ? `after MTG ${out.steps} ` : ""}(${out.pnl >= 0 ? "+" : ""}$${out.pnl.toFixed(2)})`);
    else if (out.final === "loss") onToast(`LOSS (${out.pnl >= 0 ? "+" : "-"}$${Math.abs(out.pnl).toFixed(2)})${out.message && out.message !== "loss" ? " · " + out.message : ""}`);
    else if (out.final === "error") onToast(out.message);
    else if (out.final === "cancelled") onToast("Stopped. No more MTG steps will be placed.");
  };

  // ---- Auto Scan all 31 agents (default) or scan selected market
  const generate = async () => {
    if (trading || phase === "analyzing") return;
    if (!ready) { onToast("Deriv is not connected yet. Check the API screen."); return; }
    if (timing.transitioning) { onToast("Agents are synchronizing to the new timeframe — please wait."); return; }
    const my = ++runId.current;
    setErr(""); setSg(null); setNone(""); setPhase("analyzing"); setStep(0);
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 900);
    try {
      let s: any = null;
      let resolvedSymbol = asset;
      let resolvedMarket = splitName(assets.find((a) => a.symbol === asset) ?? { symbol: asset }).label;

      if (scanAll) {
        const r = await fetch(`${http}/api/signal/autoscan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tf, expirySec: expiry }),
        });
        const d = await r.json();
        if (d.status !== "ok") throw new Error(d.msg || "Auto scan failed");
        if (my !== runId.current) return;
        s = d.signal;
        if (d.symbol) {
          resolvedSymbol = d.symbol;
          resolvedMarket = d.market || resolvedMarket;
          setAsset(d.symbol);
        }
        setScanMeta({ symbol: resolvedSymbol, market: resolvedMarket, scannedAgents: d.scannedAgents, foundCount: d.foundCount });
        setChartCandles(Array.isArray(d.closed) ? d.closed : []);
        setChartLevels(d.levels ?? null);
        setPhase("done");
        if (!s || !s.setup || !s.side) {
          setNone(d.msg || "No confirmed Stochastic+RSI+Sweep or price-action setup found across the 31 agents right now.");
          setSg({ none: true });
          return;
        }
      } else {
        const { candles, clockOff } = await fetchCandles(wsBase, "deriv", asset, tf);
        if (my !== runId.current) return;
        const r = await fetch(`${http}/api/signal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candles, tf, symbol: `deriv:${asset}`, label: resolvedMarket, now: Date.now() / 1000 + clockOff }),
        });
        const d = await r.json();
        if (d.status !== "ok") throw new Error(d.msg || "Signal service error");
        if (my !== runId.current) return;
        s = d.signal;
        setScanMeta({ symbol: asset, market: resolvedMarket });
        setChartCandles(Array.isArray(d.closed) ? d.closed : candles.slice(-85));
        setChartLevels(d.levels ?? null);
        setPhase("done");
        if (!s.setup || !s.side) {
          setNone(s.status || "No high-probability setup right now");
          setSg({ none: true, condition: s.condition });
          return;
        }
      }

      setSg(s);
      beep(s.side === "buy");
      if (auto) {
        if (s.tradeable) {
          void trade(s, resolvedSymbol, resolvedMarket);
        } else {
          onToast(`Not auto-traded: ${s.verification?.execution?.reason || s.ai?.reason || s.status || "waiting for confirmation"}`);
        }
      }
    } catch (e) {
      if (my === runId.current) { setErr((e as Error).message || "Signal failed"); setPhase("idle"); }
    } finally { clearInterval(timer); }
  };

  // Continuous Auto-Scan Monitoring: When AUTO switch is enabled, scan closed candles every 8 seconds
  useEffect(() => {
    if (!auto || view !== "setup" || !ready || timing.transitioning) return;
    const interval = setInterval(() => {
      if (!trading && phase !== "analyzing" && !timing.transitioning && alive.current) {
        void generate();
      }
    }, 8000);
    return () => clearInterval(interval);
  }, [auto, view, ready, trading, phase, asset, tf, scanAll, timing.transitioning]);

  const stopTrading = () => { cancel.current = true; runId.current++; setPhase("idle"); onToast("Stopping: the trade already placed will finish, but no more MTG steps are placed."); };
  const resetStats = () => { setRecs([]); store.set("qx-classic-trades", []); };

  // ================================================================ pair grid (optional manual override)
  if (view === "pairs") {
    return (
      <div className="qm">
        <div className="qm-head">
          <button className="qm-back" onClick={() => setView("setup")} aria-label="Back"><ArrowLeft size={20} /></button>
          <div><h1>Browse Pairs</h1><p className={`qm-status ${ready ? "ok" : ""}`}><i />{ready ? "NETWORK ACTIVE" : "CONNECTING…"}</p></div>
        </div>
        <div className="qm-seg" role="tablist">
          {GROUPS.map((g) => (
            <button key={g.id} role="tab" aria-selected={grp === g.id} className={grp === g.id ? "on" : ""} onClick={() => setGrp(g.id)}>
              {g.id === "fav" && <Star size={12} fill="currentColor" strokeWidth={0} />}{g.label}
            </button>
          ))}
        </div>
        <label className="qm-search"><Search size={18} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pair (e.g. Gold XAUUSD)" spellCheck={false} autoCapitalize="off" autoCorrect="off" /></label>
        {!synth.length && <p className="qm-muted center">Synthetic markets load once Deriv is connected.</p>}
        {!!synth.length && !rows.length && <p className="qm-muted center">{grp === "fav" && !q ? "Tap the star on a market to keep it here." : "No markets found."}</p>}
        <div className="qm-grid">
          {rows.map((a, i) => {
            const { label } = splitName(a);
            const closed = a.active === false;
            const isFav = favs.includes(a.symbol);
            return (
              <div key={a.symbol} className={`qm-pair gc ${closed ? "closed" : ""} ${a.symbol === asset ? "sel" : ""}`} style={{ animationDelay: `${Math.min(i, 16) * 40}ms` }}>
                <button className={`qm-fav ${isFav ? "on" : ""}`} aria-label={isFav ? "Remove from favorites" : "Add to favorites"} aria-pressed={isFav} onClick={() => toggleFav(a.symbol)}><Star size={15} fill={isFav ? "currentColor" : "none"} /></button>
                <button className="qm-pair-btn" disabled={closed} onClick={() => { setAsset(a.symbol); setScanAll(false); setScanMeta(null); setSg(null); setNone(""); setErr(""); setPhase("idle"); setView("setup"); }}>
                  <span className={`qm-pay ${a.payout && a.payout > 0 ? "" : "live"}`}>{closed ? "Closed" : a.payout && a.payout > 0 ? `${a.payout}%` : "Live"}</span>
                  <SynthIcon asset={a} />
                  <b>{label}</b>
                  <small>{a.symbol === "frxXAUUSD" || a.symbol.toUpperCase().includes("XAU") ? "(Commodity)" : "(Synthetic)"}</small>
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ height: 24 }} />
      </div>
    );
  }

  // ================================================================ signal generator
  const busy = phase === "analyzing";
  const side = sg && !sg.none ? (sg.side as Side) : null;
  const pending = recs.find((r) => r.result === "pending");
  const stateText = trading ? "TRADING" : busy ? "SCANNING" : "READY";
  const expOpt = BROKER_EXPIRY_OPTIONS.find((e) => e.sec === expiry) ?? { sec: expiry, label: `${expiry}s`, description: `${expiry}s` };
  const syncTotal = timing.requiredAgents.length;
  const syncDone = timing.syncedAgents.length;
  return (
    <div className="qm">
      <div className="qm-head">
        <button className="qm-back" onClick={() => { if (!trading) { runId.current++; setPhase("idle"); } onExit(); }} aria-label="Back"><ArrowLeft size={20} /></button>
        <div><h1>Classic Mode · Auto Scan</h1><p className={`qm-status ${trading || timing.transitioning ? "busy" : "ok"}`}><i />{timing.transitioning ? `SYNCING ${syncDone}/${syncTotal}` : stateText}</p></div>
        <span className={`qm-acct ${isDemo === false ? "real" : ""}`}>{isDemo === false ? "REAL" : "DEMO"}{balance != null && <b>${balance.toFixed(2)}</b>}</span>
      </div>

      <div className="qm-card gc big">
        <div className="qm-pairhead">
          {scanAll && !sg?.side ? (
            <span className="qm-ico" style={{ width: 52, height: 52, ["--c" as string]: "#38bdf8" }}><Radar size={24} /></span>
          ) : (
            <SynthIcon asset={cur} size={52} />
          )}
          <div className="grow">
            <h2>{scanAll ? (sg?.side ? `${marketLabel}` : "All 31 Market Agents (Auto Scan)") : `${marketLabel}`} <span>({scanAll && !sg?.side ? "Gold + Synthetics" : effectiveSymbol === "frxXAUUSD" ? "Commodity" : "Synthetic"})</span></h2>
            <p className="qm-live">DERIV · STOCH+RSI+SWEEP · {timing.transitioning ? `SYNCING ${syncDone}/${syncTotal}` : scanAll ? "MULTI-AGENT AI SCANNER" : "SINGLE PAIR"}</p>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {!scanAll && <button className="qm-change" onClick={() => { setScanAll(true); setScanMeta(null); }}>All Agents</button>}
            <button className="qm-change" onClick={() => setView("pairs")}>Browse Pairs</button>
          </div>
        </div>

        <div className="qm-2">
          <div className="qm-tile"><span className="qm-tico"><Clock size={20} /></span><div><small>GLOBAL TIME FRAME / EXPIRY</small><b>{tfOpt.label} / {expOpt.label}</b><em>{tfOpt.description}</em></div></div>
          <div className="qm-tile"><span className="qm-tico"><Percent size={20} /></span><div><small>PAYOUT</small><b>{payout}</b></div></div>
        </div>

        <h4 className="qm-lbl">GLOBAL TIME FRAME (ALL AGENTS)</h4>
        <div className="qm-chips">{BROKER_TIMEFRAME_OPTIONS.map((t) => <button key={t.sec} className={tf === t.sec ? "on" : ""} disabled={trading} onClick={() => { void updateTiming({ tfSec: t.sec }).then((r) => { if (!r.ok) onToast(r.error || "Timeframe update failed"); }); }}>{t.label}</button>)}</div>

        <h4 className="qm-lbl">GLOBAL TRADE EXPIRY</h4>
        <div className="qm-chips">
          {BROKER_EXPIRY_OPTIONS.map((e) => <button key={e.sec} className={expiry === e.sec ? "on" : ""} disabled={trading} onClick={() => { void updateTiming({ expirySec: e.sec }).then((r) => { if (!r.ok) onToast(r.error || "Expiry update failed"); }); }}>{e.label}</button>)}
        </div>
        <p className="qm-hint">
          {timing.transitioning
            ? `Transitioning agents to ${tfOpt.label} (${syncDone}/${syncTotal} synced). Trading is paused until all agents confirm.`
            : scanAll
              ? `Just select Timeframe (${tfOpt.label}) & Expiry (${expOpt.label}) and press AUTO SCAN to call all 31 agents and verify the best setup with Gemini AI.`
              : `Scanning ${marketLabel} on ${tfOpt.label} chart · ${expOpt.label} expiry.`}
        </p>

        <h4 className="qm-lbl">MTG STEP</h4>
        <div className="qm-chips four">{[0, 1, 2, 3].map((n) => <button key={n} className={mtgStep === n ? "on" : ""} disabled={trading} onClick={() => setMtgStep(n)}>{n === 0 ? "None" : `${n} Step${n > 1 ? "s" : ""}`}</button>)}</div>
        {mtgStep > 0 && (
          <>
            <div className="qm-chips mult"><small>Stake multiplier</small>{MULTS.map((m) => <button key={m} className={mult === m ? "on" : ""} disabled={trading} onClick={() => setMult(m)}>×{m}</button>)}</div>
            <p className="qm-hint warn"><ShieldAlert size={14} /><span>After a loss the same side is re-entered with stakes {plan.stakes.map((s) => `$${s}`).join(" → ")}. If every step loses you lose <b>${plan.worstCase.toFixed(2)}</b>.</span></p>
          </>
        )}

        <div className="qm-stakerow">
          <label><small>STAKE ($)</small><input inputMode="decimal" value={stake} disabled={trading} onChange={(e) => { setStake(e.target.value); const n = parseFloat(e.target.value); if (n > 0) store.set("qx-cl-stake", n); }} /></label>
          <button className={`qm-auto ${auto ? "on" : ""}`} role="switch" aria-checked={auto} disabled={trading} onClick={() => setAuto((a) => !a)}>
            <span className="qm-sw"><i /></span><span><b>AUTO TRADE</b><small>{auto ? "Auto-places trade once verified" : "Manual entry after signal"}</small></span>
          </button>
        </div>

        {trading
          ? <button className="qm-go stop" onClick={stopTrading}><Square size={18} fill="currentColor" /> STOP AFTER THIS TRADE</button>
          : <button className="qm-go" disabled={busy || timing.transitioning} onClick={generate}><RefreshCw size={19} className={busy ? "spin" : ""} /> {timing.transitioning ? "SYNCING AGENTS…" : busy ? "AUTO SCANNING AGENTS…" : auto ? "AUTO SCAN & AUTO TRADE" : "AUTO SCAN"}</button>}
      </div>

      {(busy || sg || err || none) && (
        <div className={`qm-card result ${side ? "gc" : ""} ${side ?? ""} ${phase}`}>
          {busy && (
            <div className="qm-an"><div className="qm-radar"><i /><i /><i /><Activity size={26} /></div><h3>{scanAll ? "Calling all 31 market agents…" : `Analyzing ${marketLabel}`}</h3>
              <ul>{STEPS.map((s, i) => <li key={s} className={i < step ? "ok" : i === step ? "now" : ""}>{i < step ? "✓" : i === step ? "●" : "○"} {s}</li>)}</ul></div>
          )}
          {!busy && err && <div className="qm-empty"><h3>Could not complete scan</h3><p>{err}</p></div>}
          {!busy && !err && none && <div className="qm-empty"><h3>No high-probability setup</h3><p>{none}</p><p className="qm-muted">The 31 agents check every closed candle for Stochastic+RSI+Sweep and price-action setups.</p></div>}
          {!busy && side && sg && (
            <div className="qm-out">
              <div className="qm-call">
                <span className="qm-arrow">{side === "buy" ? <ArrowUp size={34} strokeWidth={3} /> : <ArrowDown size={34} strokeWidth={3} />}</span>
                <div>
                  <strong>{side === "buy" ? "BUY" : "SELL"}</strong>
                  <small>{marketLabel} · {tfOpt.label} · {pickedAuto(sg).expiry}s expiry{scanMeta?.foundCount ? ` · Best of ${scanMeta.foundCount} active setups` : ""}</small>
                </div>
                <div className="qm-conf">
                  {sg.verification?.aiConfidence != null
                    ? <><b>{sg.verification.aiConfidence}%</b><small>AI confidence</small></>
                    : sg.live?.ready
                      ? <><b>{sg.live.pct}%</b><small>live win rate · n={sg.live.n}</small></>
                      : <><b>{sg.confidence}%</b><small>strategy score</small></>}
                </div>
              </div>
              {sg.live && <p className={`qm-hint${sg.live.verdict === "below" ? " warn" : ""}`}>{sg.live.text}</p>}
              <div className="qm-eng">
                <span className={sg.engine?.stochRsiSweep ? "on" : ""}>Stoch+RSI</span>
                <span className={sg.engine?.sweep || sg.engine?.lscc || sg.engine?.structureSweep ? "on" : ""}>Sweep</span>
                <span className={sg.engine?.pattern?.counted || (sg.engine?.stochRsiSweep?.confirmations?.length ?? 0) > 0 ? "on" : ""}>Pattern</span>
                <span className={sg.tradeable ? "on" : "off"}>{sg.decision === "VALID_WITH_RISK" ? "Valid with risk" : sg.decision === "AI_UNAVAILABLE" ? "AI unavailable" : sg.decision === "REVIEW" ? "Needs review" : sg.tradeable ? (sg.verification?.visualVerification ? "AI verified (chart)" : "AI verified") : "Not verified"}</span>
              </div>
              {!sg.tradeable && <p className="qm-hint warn"><ShieldAlert size={14} /><span>Not auto-traded: {sg.verification?.execution?.reason || sg.ai?.reason || "the AI did not verify this setup"}.</span></p>}
              {sg.tradeable && !auto && !trading && (
                <button className={`qm-go ${side}`} onClick={() => void trade(sg)}>{side === "buy" ? <ArrowUp size={18} /> : <ArrowDown size={18} />} PLACE {side.toUpperCase()} · ${stakeNum || 0}</button>
              )}
              {pending && trading && <p className="qm-hint">Trade running. The result arrives automatically{mtgStep ? " and MTG recovery follows after a loss" : ""}.</p>}
              {sg.hybrid && sg.hybrid.mode !== "off" && <p className="qm-hint">Hybrid engine: {String(sg.hybrid.status).replace(/_/g, " ").toLowerCase()}{sg.hybrid.probability != null ? ` · P(win) ${sg.hybrid.probability.toFixed(3)}` : ""}{sg.hybrid.allow ? "" : " · BLOCKS this trade"}</p>}
              {sg.contract?.detected_issues?.length > 0 && <p className="qm-hint">AI notes: {sg.contract.detected_issues.slice(0, 4).join(" · ")}</p>}
              {Array.isArray(sg.reasons) && sg.reasons.length > 0 && <ul className="qm-why">{sg.reasons.slice(0, 5).map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>}

              <SignalChartCard
                http={http}
                symbol={effectiveSymbol}
                label={marketLabel}
                payout={payout}
                tfSec={tf}
                expirySec={expiry}
                side={side}
                signal={sg}
                initialCandles={chartCandles}
                levels={chartLevels}
                mtgStep={mtgStep}
                recs={recs}
                activeTrade={pending ?? recs[0] ?? null}
              />
            </div>
          )}
        </div>
      )}

      <div className="qm-card">
        <div className="qm-cardtop"><h3>Trades</h3>{recs.length > 0 && !trading && <button className="qm-link" onClick={resetStats}>Reset</button>}</div>
        <StatTiles s={summary} />
        <TradeList recs={recs} now={now} />
      </div>
      <p className="qm-disc">Confidence reflects indicator confluence and market-condition calibration, not guaranteed profit. MTG multiplies your stake after losses and can lose a lot quickly. Trade only what you can afford to lose. Not financial advice.</p>
      <div style={{ height: 24 }} />
    </div>
  );
}
