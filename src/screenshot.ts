// The market-chart screenshot that goes to the vision model. It is drawn HERE, from the very same closed candles the numeric
// data and the engines used (one feed, one set of timestamps), so the picture and the numbers cannot come from different sources.
// It reuses the app's own chart renderer (src/sweepChart.ts) for sweep setups; the chart engine and UI are untouched.
import { appendOscillatorSubPanels, renderAlertSvg } from './sweepChart';
import type { Bar, PatternVerification, Side, SweepEngineKey } from './patternVerification';
import { ScreenshotImage, candleLabel, candleSetHash, sha256 } from './aiVerification';

/** SVG text in, PNG bytes out (the Gemini API does not read SVG). null = no rasterizer is installed. */
export type Rasterizer = (svg: string) => Promise<Uint8Array | null>;

export const SCREENSHOT_CANDLES = 24;

/** Tries @resvg/resvg-js, then sharp. Neither is imported unless it is installed; without one the pipeline reports NOT_SENT honestly. */
export const defaultRasterizer: Rasterizer = async (svg) => {
  const load = async (name: string): Promise<any | null> => { try { return await import(/* @vite-ignore */ name); } catch { return null; } };
  const resvg = await load('@resvg/resvg-js');
  if (resvg?.Resvg) return new resvg.Resvg(svg, { fitTo: { mode: 'width', value: 1168 }, font: { loadSystemFonts: true } }).render().asPng();
  const sharp = await load('sharp');
  const fn = sharp?.default ?? sharp;
  if (typeof fn === 'function') return await fn(Buffer.from(svg)).png().toBuffer();
  return null;
};

const GREEN = '#3cb54f', RED = '#e8202e', BG = '#030a1a', GRID = '#1b2742', DIM = '#8a96b4', FONT = "Inter, 'Segoe UI', Arial, Helvetica, sans-serif";

/** Plain candlestick + indicator chart for setups with no sweep pattern (indicator or candlestick-pattern setups). */
export function renderPlainSvg(allCandles: Bar[], side: Side, market: string, tf: number): string {
  const W = 1168, H = 840, L = 118, R = 1128, T = 152, B = 500;
  const cs = allCandles.slice(-SCREENSHOT_CANDLES);
  const n = cs.length;
  if (n === 0) return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>';
  const slot = (R - L) / (n + 3), bw = slot * 0.56;
  const lo = Math.min(...cs.map((c) => c.low)), hi = Math.max(...cs.map((c) => c.high));
  const span = Math.max(hi - lo, 1e-9), ymin = lo - span * 0.1, ymax = hi + span * 0.1;
  const y = (p: number) => B - ((p - ymin) / (ymax - ymin)) * (B - T);
  const x = (i: number) => L + slot * (i + 0.5);
  const dec = hi >= 1000 ? 2 : hi >= 100 ? 3 : hi >= 10 ? 4 : 5;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">`, `<rect width="${W}" height="${H}" fill="${BG}"/>`];
  for (let k = 0; k < 7; k++) {
    const p = ymin + ((ymax - ymin) * k) / 6, yy = y(p);
    out.push(`<line x1="${L}" y1="${yy.toFixed(1)}" x2="${R}" y2="${yy.toFixed(1)}" stroke="${GRID}" stroke-width="1.5" stroke-dasharray="7 7"/>`);
    out.push(`<text x="${L - 12}" y="${(yy + 6).toFixed(1)}" fill="${DIM}" font-size="17" text-anchor="end">${p.toFixed(dec)}</text>`);
  }
  appendOscillatorSubPanels(out, allCandles, n, x, y);
  cs.forEach((c, i) => {
    const col = c.close >= c.open ? GREEN : RED, xx = x(i);
    out.push(`<line x1="${xx.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${xx.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}" stroke-width="3"/>`);
    const top = y(Math.max(c.open, c.close)), bot = y(Math.min(c.open, c.close));
    out.push(`<rect x="${(xx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(bot - top, 2).toFixed(1)}" fill="${col}"/>`);
  });
  const tfl = tf < 60 ? `${tf}s` : `${Math.floor(tf / 60)}m`;
  out.push(`<text x="${W / 2}" y="52" fill="#fff" font-size="34" font-weight="700" text-anchor="middle">${side} signal \u2013 Price + EMA + RSI(14) + Stoch(14,3,3)</text>`);
  out.push(`<text x="${W / 2}" y="92" fill="${DIM}" font-size="22" text-anchor="middle">${esc(market)} \u00b7 ${tfl} \u00b7 last closed candle ${candleLabel(cs[n - 1].time)}</text>`);
  out.push('</svg>');
  return out.join('\n');
}

const PATTERN_LEN: Record<SweepEngineKey, number> = { sweep: 2, momentum: 3, continuation: 4, lscc: 3, structure_sweep: 2, stoch_rsi_sweep: 4 };

export function renderSignalSvg(closed: Bar[], side: Side, pattern: PatternVerification, market: string, symbol: string, tf: number): string {
  const first = pattern.claimed[0];
  const cs = closed.slice(-60);
  if (!first || (pattern.sweptLevel == null && first.engine !== 'stoch_rsi_sweep')) return renderPlainSvg(cs, side, market, tf);
  return renderAlertSvg(cs, {
    engine: first.engine, side: first.side, ok: true, swept_level: pattern.sweptLevel ?? cs[cs.length - 1]?.low ?? 0, tf, market, symbol,
    notes: [], patternLen: PATTERN_LEN[first.engine],
  });
}

/** Renders and rasterizes the screenshot of the last 16 closed candles. null when no rasterizer is available. */
export async function buildScreenshot(
  closed: Bar[], side: Side, pattern: PatternVerification, market: string, symbol: string, tf: number,
  rasterize: Rasterizer = defaultRasterizer, nowMs = Date.now(),
): Promise<ScreenshotImage | null> {
  if (!closed.length) return null;
  let png: Uint8Array | null = null;
  try { png = await rasterize(renderSignalSvg(closed, side, pattern, market, symbol, tf)); } catch { png = null; }
  if (!png || !png.length) return null;
  const shown = closed.slice(-SCREENSHOT_CANDLES);
  const last = shown[shown.length - 1];
  return {
    mimeType: 'image/png', base64: Buffer.from(png).toString('base64'), sha256: sha256(png),
    lastCandleTime: last.time, lastCandleLabel: candleLabel(last.time), renderedAt: Math.floor(nowMs / 1000),
    candleSetHash: candleSetHash(closed.slice(-60)),
  };
}
