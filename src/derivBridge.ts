import { WebSocket } from 'ws';
import fs from 'fs';
import https from 'https';

const SESSION_FILE = '/tmp/deriv_token.txt';
const REST_BASE = 'https://api.derivws.com';

const WS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Origin': 'https://app.deriv.com',
  'Accept-Language': 'en-US,en;q=0.9'
};

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DerivAsset {
  symbol: string;
  name: string;
  payout: number;
  active: boolean;
}

const DEFAULT_SYNTHETICS: DerivAsset[] = [
  { symbol: "frxXAUUSD", name: "Gold / USD (XAUUSD)", payout: 95, active: true },
  { symbol: "1HZ10V", name: "Volatility 10 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ25V", name: "Volatility 25 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ50V", name: "Volatility 50 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ75V", name: "Volatility 75 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ100V", name: "Volatility 100 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ150V", name: "Volatility 150 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ200V", name: "Volatility 200 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ250V", name: "Volatility 250 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ300V", name: "Volatility 300 (1s) Index", payout: 95, active: true },
  { symbol: "R_10", name: "Volatility 10 Index", payout: 95, active: true },
  { symbol: "R_25", name: "Volatility 25 Index", payout: 95, active: true },
  { symbol: "R_50", name: "Volatility 50 Index", payout: 95, active: true },
  { symbol: "R_75", name: "Volatility 75 Index", payout: 95, active: true },
  { symbol: "R_100", name: "Volatility 100 Index", payout: 95, active: true },
  { symbol: "R_150", name: "Volatility 150 Index", payout: 95, active: true },
  { symbol: "R_200", name: "Volatility 200 Index", payout: 95, active: true },
  { symbol: "R_250", name: "Volatility 250 Index", payout: 95, active: true },
  { symbol: "R_300", name: "Volatility 300 Index", payout: 95, active: true },
  { symbol: "BOOM300", name: "Boom 300 Index", payout: 95, active: true },
  { symbol: "BOOM500", name: "Boom 500 Index", payout: 95, active: true },
  { symbol: "BOOM1000", name: "Boom 1000 Index", payout: 95, active: true },
  { symbol: "CRASH300", name: "Crash 300 Index", payout: 95, active: true },
  { symbol: "CRASH500", name: "Crash 500 Index", payout: 95, active: true },
  { symbol: "CRASH1000", name: "Crash 1000 Index", payout: 95, active: true },
  { symbol: "stpRNG", name: "Step Index 100", payout: 95, active: true },
  { symbol: "STEP", name: "Step Index", payout: 95, active: true },
  { symbol: "JD10", name: "Jump 10 Index", payout: 95, active: true },
  { symbol: "JD25", name: "Jump 25 Index", payout: 95, active: true },
  { symbol: "JD50", name: "Jump 50 Index", payout: 95, active: true },
  { symbol: "JD75", name: "Jump 75 Index", payout: 95, active: true },
  { symbol: "JD100", name: "Jump 100 Index", payout: 95, active: true },
];

export class DerivBridge {
  public token: string = '';
  public appId: string = '34QcI4Rf8S5tCkL6PMOcI';
  public accountId: string = '';
  private preferredAccountId: string = '';
  public ready: boolean = false;
  public error: string = '';
  public authError: string = '';
  /** true only when the authenticated (trading) websocket is open: the public data feed alone cannot place orders */
  get tradable(): boolean { return !!this.authWs && this.authWs.readyState === WebSocket.OPEN; }
  public balance: number | null = null;
  public currency: string = 'USD';
  public isDemo: boolean = true;
  public assets: DerivAsset[] = [...DEFAULT_SYNTHETICS];
  public accountList: Array<{ loginid: string; is_virtual: number; account_type?: string }> = [];

  private publicWs: WebSocket | null = null;
  private authWs: WebSocket | null = null;
  private pendingPublicRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private pendingAuthRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private reqId = 1;
  private authReqId = 1000;
  private tickSubscribers = new Map<string, Set<(price: number, epoch: number) => void>>();
  private tickSubIds = new Map<string, string>();
  private publicReconnectTimer: NodeJS.Timeout | null = null;
  private authReconnectTimer: NodeJS.Timeout | null = null;
  private publicPingTimer: NodeJS.Timeout | null = null;
  private authPingTimer: NodeJS.Timeout | null = null;
  private authInitPromise: Promise<void> | null = null;

  constructor() {
    this.loadToken();
    this.connectPublicWs();
    void this.initAuth();
  }

  private loadToken() {
    let rawToken = '';
    if (fs.existsSync(SESSION_FILE)) {
      try {
        rawToken = fs.readFileSync(SESSION_FILE, 'utf-8').trim();
      } catch {}
    }
    if (!rawToken) {
      rawToken = process.env.DERIV_TOKEN || process.env.DERIV_API_KEY || '';
    }
    if (!rawToken) {
      rawToken = 'pat_12430e9f3555e6dd3a2ad5bb86555b0a530667adbd0b8efd1f97b3abdcdaf106';
    }
    this.parseTokenString(rawToken);
  }

  public parseTokenString(raw: string) {
    const parts = raw.split('|').map(p => p.trim());
    this.token = parts[0] || '';
    this.appId = parts[1] || '34QcI4Rf8S5tCkL6PMOcI';
    this.preferredAccountId = parts[2] || '';
    if (this.preferredAccountId) this.accountId = this.preferredAccountId;
  }

  public async setCredentials(raw: string): Promise<{ ok: boolean; msg: string }> {
    this.parseTokenString(raw);
    try {
      fs.writeFileSync(SESSION_FILE, raw);
    } catch {}
    if (this.authReconnectTimer) {
      clearTimeout(this.authReconnectTimer);
      this.authReconnectTimer = null;
    }
    if (this.authPingTimer) {
      clearInterval(this.authPingTimer);
      this.authPingTimer = null;
    }
    const prevWs = this.authWs;
    this.authWs = null;
    if (prevWs) {
      try { prevWs.close(); } catch {}
    }
    this.authError = '';
    this.balance = null;
    this.authInitPromise = null;
    try {
      await this.ensureAuthConnected(15000);
      return {
        ok: true,
        msg: `Connected to Deriv (${this.isDemo ? 'DEMO' : 'REAL'} · ${this.accountId})`,
      };
    } catch (err: any) {
      return { ok: false, msg: err?.message || this.authError || 'Failed to authenticate Deriv token' };
    }
  }

  // --- 1. Public Market Data Connection ---
  private connectPublicWs() {
    if (this.publicReconnectTimer) {
      clearTimeout(this.publicReconnectTimer);
      this.publicReconnectTimer = null;
    }
    if (this.publicPingTimer) {
      clearInterval(this.publicPingTimer);
      this.publicPingTimer = null;
    }
    const prevWs = this.publicWs;
    this.publicWs = null;
    if (prevWs) {
      try { prevWs.close(); } catch {}
    }

    const primaryUrl = 'wss://api.derivws.com/trading/v1/options/ws/public';
    console.log(`[DerivBridge] Connecting public market stream to ${primaryUrl}...`);

    try {
      const ws = new WebSocket(primaryUrl, { headers: WS_HEADERS });
      this.publicWs = ws;

      ws.on('open', () => {
        if (ws !== this.publicWs) return;
        console.log(`[DerivBridge] Public Market Data Connected`);
        this.ready = true;
        this.error = '';

        this.publicPingTimer = setInterval(() => {
          if (ws === this.publicWs && ws.readyState === WebSocket.OPEN) {
            this.requestPublic({ ping: 1 }).catch(() => {});
          }
        }, 25000);

        // Re-subscribe any pending tick subscribers
        for (const sym of this.tickSubscribers.keys()) {
          this.requestPublic({ ticks: sym, subscribe: 1 }).catch(() => {});
        }

        // Load active symbols
        this.requestPublic({ active_symbols: 'brief' }).then((res) => {
          if (res && Array.isArray(res.active_symbols)) {
            const parsed = res.active_symbols
              .filter((s: any) => {
                const sym = (s.underlying_symbol || s.symbol || '').toUpperCase();
                return sym === 'FRXXAUUSD' || sym === 'WLDXAU' || sym.startsWith('R_') || sym.startsWith('1HZ') || sym.startsWith('BOOM') ||
                  sym.startsWith('CRASH') || sym.startsWith('STEP') || sym.startsWith('JD') || sym.startsWith('STP');
              })
              .map((s: any) => {
                const sym = s.underlying_symbol || s.symbol;
                const isGold = sym === 'frxXAUUSD' || sym.toUpperCase() === 'FRXXAUUSD';
                return {
                  symbol: sym,
                  name: isGold ? 'Gold / USD (XAUUSD)' : (s.underlying_symbol_name || s.display_name || sym),
                  payout: 95,
                  active: !s.is_trading_suspended && (s.exchange_is_open === 1 || s.exchange_is_open === undefined)
                };
              });
            if (parsed.length > 0) {
              if (!parsed.some((p: any) => p.symbol === 'frxXAUUSD')) {
                parsed.unshift({ symbol: 'frxXAUUSD', name: 'Gold / USD (XAUUSD)', payout: 95, active: true });
              }
              this.assets = parsed;
            }
          }
        }).catch(() => {});
      });

      ws.on('message', (data: any) => {
        if (ws !== this.publicWs) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.req_id && this.pendingPublicRequests.has(msg.req_id)) {
            const { resolve } = this.pendingPublicRequests.get(msg.req_id)!;
            this.pendingPublicRequests.delete(msg.req_id);
            resolve(msg);
          }

          if (msg.msg_type === 'tick' && msg.tick) {
            const sym = msg.tick.symbol;
            const price = Number(msg.tick.quote);
            const epoch = Number(msg.tick.epoch);
            if (msg.subscription && msg.subscription.id && sym) {
              this.tickSubIds.set(sym, msg.subscription.id);
            }
            if (sym && this.tickSubscribers.has(sym)) {
              for (const cb of this.tickSubscribers.get(sym)!) {
                cb(price, epoch);
              }
            }
          }
        } catch {}
      });

      ws.on('error', (err) => {
        if (ws !== this.publicWs) return;
        console.warn(`[DerivBridge] Public WS Warning: ${err.message}`);
        this.ready = false;
      });

      ws.on('close', () => {
        if (ws !== this.publicWs) return;
        this.ready = false;
        this.publicWs = null;
        if (this.publicPingTimer) {
          clearInterval(this.publicPingTimer);
          this.publicPingTimer = null;
        }
        for (const [id, p] of this.pendingPublicRequests.entries()) {
          this.pendingPublicRequests.delete(id);
          p.reject(new Error('Deriv Public WS closed'));
        }
        if (!this.publicReconnectTimer) {
          this.publicReconnectTimer = setTimeout(() => {
            this.publicReconnectTimer = null;
            this.connectPublicWs();
          }, 3000);
        }
      });
    } catch (err: any) {
      this.error = `Failed to connect public market WS: ${err.message}`;
    }
  }

  // --- 2. Authenticated Account Connection via REST OTP ---
  public async initAuth(): Promise<void> {
    if (this.authInitPromise) return this.authInitPromise;
    this.authInitPromise = this.doInitAuth().finally(() => {
      this.authInitPromise = null;
    });
    return this.authInitPromise;
  }

  private async doInitAuth(): Promise<void> {
    if (this.authReconnectTimer) {
      clearTimeout(this.authReconnectTimer);
      this.authReconnectTimer = null;
    }
    if (!this.token || this.token.startsWith('MY_')) {
      this.authError = 'No Deriv API Token configured. Enter your PAT on the API screen.';
      return;
    }

    try {
      // Step A: Fetch accounts list
      const accountsRes = await this.httpApiGet('/trading/v1/options/accounts');
      const apiErr = accountsRes?.errors?.[0]?.message || accountsRes?.error?.message;
      if (apiErr) {
        this.authError = `Deriv Auth Error: ${apiErr}`;
        return;
      }
      if (!accountsRes || !Array.isArray(accountsRes.data) || accountsRes.data.length === 0) {
        this.authError = 'No Deriv accounts found on this token';
        return;
      }

      const accList = accountsRes.data;
      this.accountList = accList.map((a: any) => ({
        loginid: a.account_id,
        is_virtual: a.account_type === 'demo' ? 1 : 0,
        account_type: a.account_type
      }));

      // Find matching account (explicit ID if provided, otherwise demo vs real)
      let selectedAcc = this.preferredAccountId
        ? accList.find((a: any) => a.account_id === this.preferredAccountId && (a.account_type === 'demo') === this.isDemo)
          ?? accList.find((a: any) => a.account_id === this.preferredAccountId)
        : undefined;
      if (!selectedAcc) {
        selectedAcc = accList.find((a: any) => (a.account_type === 'demo') === this.isDemo);
      }
      if (!selectedAcc) selectedAcc = accList[0];

      this.accountId = selectedAcc.account_id;
      this.balance = Number(selectedAcc.balance || 0);
      this.currency = selectedAcc.currency || 'USD';
      this.isDemo = selectedAcc.account_type === 'demo';
      this.authError = '';

      console.log(`[DerivBridge] Deriv Account Identified: ${this.accountId} (${this.isDemo ? 'DEMO' : 'REAL'}). Balance: ${this.balance} ${this.currency}`);

      // Step B: Fetch OTP WebSocket URL
      const otpRes = await this.httpApiPost(`/trading/v1/options/accounts/${this.accountId}/otp`);
      const otpErr = otpRes?.errors?.[0]?.message || otpRes?.error?.message;
      if (otpErr) {
        this.authError = `Failed to obtain Deriv OTP session: ${otpErr}`;
        return;
      }
      if (!otpRes || !otpRes.data || !otpRes.data.url) {
        this.authError = 'Failed to obtain Deriv OTP session';
        return;
      }

      const otpUrl = otpRes.data.url;
      this.connectAuthWs(otpUrl);
    } catch (err: any) {
      this.authError = `Deriv Login Exception: ${err.message}`;
      console.warn(`[DerivBridge] Auth initialization error: ${err.message}`);
    }
  }

  private connectAuthWs(otpUrl: string) {
    if (this.authPingTimer) {
      clearInterval(this.authPingTimer);
      this.authPingTimer = null;
    }
    const prevWs = this.authWs;
    this.authWs = null;
    if (prevWs) {
      try { prevWs.close(); } catch {}
    }

    try {
      const ws = new WebSocket(otpUrl, { headers: WS_HEADERS });
      this.authWs = ws;

      ws.on('open', () => {
        if (ws !== this.authWs) return;
        console.log(`[DerivBridge] Authenticated Deriv Session Opened (${this.accountId})`);
        this.authError = '';
        // Subscribe to live balance updates & keepalive ping so Deriv never drops idle sessions
        this.requestAuth({ balance: 1, subscribe: 1 }).catch(() => {});
        this.authPingTimer = setInterval(() => {
          if (ws === this.authWs && ws.readyState === WebSocket.OPEN) {
            this.requestAuth({ ping: 1 }).catch(() => {});
          }
        }, 25000);
      });

      ws.on('message', (data: any) => {
        if (ws !== this.authWs) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.req_id && this.pendingAuthRequests.has(msg.req_id)) {
            const { resolve } = this.pendingAuthRequests.get(msg.req_id)!;
            this.pendingAuthRequests.delete(msg.req_id);
            resolve(msg);
          }

          if (msg.msg_type === 'balance' && msg.balance) {
            this.balance = Number(msg.balance.balance);
            this.currency = msg.balance.currency || this.currency;
          }
        } catch {}
      });

      ws.on('error', (err) => {
        if (ws !== this.authWs) return;
        console.warn(`[DerivBridge] Auth WS warning: ${err.message}`);
      });

      ws.on('close', () => {
        if (ws !== this.authWs) return;
        this.authWs = null;
        if (this.authPingTimer) {
          clearInterval(this.authPingTimer);
          this.authPingTimer = null;
        }
        for (const [id, p] of this.pendingAuthRequests.entries()) {
          this.pendingAuthRequests.delete(id);
          p.reject(new Error('Deriv Auth WS not connected'));
        }
        console.log(`[DerivBridge] Auth WS closed. Refreshing OTP in 2s...`);
        if (!this.authReconnectTimer) {
          this.authReconnectTimer = setTimeout(() => {
            this.authReconnectTimer = null;
            void this.initAuth();
          }, 2000);
        }
      });
    } catch (err: any) {
      this.authError = `Auth WS Error: ${err.message}`;
    }
  }

  // --- HTTP Helpers ---
  private httpApiGet(endpoint: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.derivws.com',
        path: endpoint,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Deriv-App-ID': this.appId || '34QcI4Rf8S5tCkL6PMOcI',
          'User-Agent': WS_HEADERS['User-Agent']
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.setTimeout(12000, () => {
        req.destroy(new Error('Deriv REST GET timeout'));
      });
      req.on('error', reject);
      req.end();
    });
  }

  private httpApiPost(endpoint: string, bodyObj = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(bodyObj);
      const options = {
        hostname: 'api.derivws.com',
        path: endpoint,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Deriv-App-ID': this.appId || '34QcI4Rf8S5tCkL6PMOcI',
          'User-Agent': WS_HEADERS['User-Agent'],
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.setTimeout(12000, () => {
        req.destroy(new Error('Deriv REST POST timeout'));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // --- Request Wrappers ---
  public async ensurePublicConnected(timeoutMs = 15000): Promise<void> {
    if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) return;
    if (!this.publicWs || this.publicWs.readyState === WebSocket.CLOSED || this.publicWs.readyState === WebSocket.CLOSING) {
      this.connectPublicWs();
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Deriv Public WS not connected');
  }

  public async requestPublic(payload: any, timeoutMs = 15000): Promise<any> {
    await this.ensurePublicConnected(timeoutMs);
    return new Promise((resolve, reject) => {
      if (!this.publicWs || this.publicWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('Deriv Public WS not connected'));
      }
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        if (this.pendingPublicRequests.has(id)) {
          this.pendingPublicRequests.delete(id);
          reject(new Error('Deriv Public Request Timeout'));
        }
      }, timeoutMs);

      this.pendingPublicRequests.set(id, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });

      this.publicWs.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  public requestAuth(payload: any, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.authWs || this.authWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('Deriv Auth WS not connected'));
      }
      const id = ++this.authReqId;
      const timer = setTimeout(() => {
        if (this.pendingAuthRequests.has(id)) {
          this.pendingAuthRequests.delete(id);
          reject(new Error('Deriv Auth Request Timeout'));
        }
      }, timeoutMs);

      this.pendingAuthRequests.set(id, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });

      this.authWs.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  private getSymbolAliases(symbol: string): string[] {
    const list = [symbol];
    const upper = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (upper === 'XAUUSD' || upper === 'GOLD' || upper === 'XAU' || upper === 'FRXXAUUSD') {
      return ['frxXAUUSD', 'WLDXAU'];
    }
    if (symbol === 'BOOM300') list.push('BOOM300N');
    else if (symbol === 'CRASH300') list.push('CRASH300N');
    else if (symbol === 'BOOM150') list.push('BOOM150N');
    else if (symbol === 'CRASH150') list.push('CRASH150N');
    else if (symbol === 'stpRNG') list.push('STEP', 'STPRNG');
    else if (symbol === 'STEP') list.push('stpRNG', 'STPRNG');
    else if (symbol === '1HZ200V') list.push('1HZ90V', '1HZ100V');
    else if (symbol === '1HZ300V') list.push('1HZ100V', '1HZ75V');
    else if (symbol === 'R_150' || symbol === 'R_200' || symbol === 'R_250' || symbol === 'R_300') list.push('R_100', 'R_75');
    if (symbol.startsWith('1HZ') && !symbol.endsWith('V')) list.push(symbol + 'V');
    if (symbol.startsWith('1HZ') && symbol.endsWith('V')) list.push(symbol.slice(0, -1));
    return Array.from(new Set(list));
  }

  // --- Gapless Candle Stitching ---
  public async getCandles(symbol: string, tf: number, count: number): Promise<Candle[]> {
    tf = Number(tf) || 60;
    count = Math.max(10, Math.min(1000, Number(count) || 60));

    const symbolsToTry = this.getSymbolAliases(symbol);

    for (const sym of symbolsToTry) {
      try {
        const res = await this.requestPublic({
          ticks_history: sym,
          adjust_start_time: 1,
          count: count,
          end: 'latest',
          granularity: tf,
          style: 'candles'
        });

        let rawCandles: Candle[] = [];
        if (res && Array.isArray(res.candles) && res.candles.length > 0) {
          rawCandles = res.candles.map((c: any) => ({
            time: Number(c.epoch),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close)
          }));
        }

        if (rawCandles.length > 0) {
          return this.stitchCandleGaps(rawCandles, tf);
        }
      } catch (err: any) {
        if (sym === symbol && !err?.message?.includes('Deriv Public WS not connected')) {
          console.warn(`[DerivBridge] getCandles retry for ${sym}:`, err?.message || err);
        }
      }
    }

    return [];
  }

  public stitchCandleGaps(raw: Candle[], tf: number): Candle[] {
    if (raw.length === 0) return [];
    raw.sort((a, b) => a.time - b.time);

    const map = new Map<number, Candle>();
    for (const c of raw) {
      const b = Math.floor(c.time / tf) * tf;
      map.set(b, { ...c, time: b });
    }

    const tMin = Math.floor(raw[0].time / tf) * tf;
    const tMax = Math.floor(raw[raw.length - 1].time / tf) * tf;
    const result: Candle[] = [];

    let prevClose = raw[0].open;
    for (let t = tMin; t <= tMax; t += tf) {
      if (map.has(t)) {
        const cand = map.get(t)!;
        prevClose = cand.close;
        result.push(cand);
      } else {
        result.push({
          time: t,
          open: prevClose,
          high: prevClose,
          low: prevClose,
          close: prevClose
        });
      }
    }
    return result;
  }

  // --- Subscriptions ---
  public subscribeTicks(symbol: string, callback: (price: number, epoch: number) => void) {
    if (!this.tickSubscribers.has(symbol)) {
      this.tickSubscribers.set(symbol, new Set());
      if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) {
        this.requestPublic({ ticks: symbol, subscribe: 1 }).catch(() => {});
      }
    }
    this.tickSubscribers.get(symbol)!.add(callback);
  }

  public unsubscribeTicks(symbol: string, callback: (price: number, epoch: number) => void) {
    const subs = this.tickSubscribers.get(symbol);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) {
        this.tickSubscribers.delete(symbol);
        const subId = this.tickSubIds.get(symbol);
        if (subId && this.publicWs && this.publicWs.readyState === WebSocket.OPEN) {
          this.requestPublic({ forget: subId }).catch(() => {});
          this.tickSubIds.delete(symbol);
        }
      }
    }
  }

  public async ensureAuthConnected(timeoutMs = 15000): Promise<void> {
    if (this.authWs && this.authWs.readyState === WebSocket.OPEN) return;
    if (!this.token || this.token.startsWith('MY_')) {
      throw new Error('Deriv account not connected. Please enter your Deriv PAT Token on the API screen.');
    }

    if (!this.authWs || this.authWs.readyState === WebSocket.CLOSED || this.authWs.readyState === WebSocket.CLOSING) {
      await this.initAuth();
    }

    if (this.authError && (!this.authWs || this.authWs.readyState === WebSocket.CLOSED)) {
      throw new Error(this.authError);
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.authWs && this.authWs.readyState === WebSocket.OPEN) return;
      if (this.authError && !this.authInitPromise && (!this.authWs || this.authWs.readyState === WebSocket.CLOSED)) {
        throw new Error(this.authError);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(this.authError || 'Deriv account not connected. Please enter your Deriv PAT Token on the API screen.');
  }

  // --- Account & Trade Operations ---
  public async setAccount(demo: boolean): Promise<{ ok: boolean; msg: string }> {
    this.isDemo = demo;
    this.preferredAccountId = '';
    if (this.authReconnectTimer) {
      clearTimeout(this.authReconnectTimer);
      this.authReconnectTimer = null;
    }
    const prevWs = this.authWs;
    this.authWs = null;
    if (prevWs) {
      try { prevWs.close(); } catch {}
    }
    this.authInitPromise = null;
    await this.ensureAuthConnected(15000);
    return { ok: true, msg: `Switched to ${this.isDemo ? 'Demo' : 'Real'} account (${this.accountId})` };
  }

  public async placeTrade(asset: string, side: 'buy' | 'sell', amount: number, seconds: number): Promise<any> {
    await this.ensureAuthConnected(15000);

    const contractType = side.toLowerCase() === 'buy' ? 'CALL' : 'PUT';
    const resolvedAsset = this.getSymbolAliases(asset)[0] || asset;

    // Step 1: Proposal (try underlying_symbol first as required by Deriv API, then symbol as fallback)
    let propRes: any = null;
    const baseProposal = {
      proposal: 1,
      amount: Number(amount),
      basis: 'stake',
      currency: this.currency,
      contract_type: contractType,
      duration: Math.max(15, Number(seconds)),
      duration_unit: 's'
    };

    try {
      propRes = await this.requestAuth({
        ...baseProposal,
        underlying_symbol: resolvedAsset
      });
    } catch (err: any) {
      if (String(err?.message || '').includes('not connected')) {
        await this.ensureAuthConnected(15000);
        try {
          propRes = await this.requestAuth({
            ...baseProposal,
            underlying_symbol: resolvedAsset
          });
        } catch {
          propRes = null;
        }
      } else {
        propRes = null;
      }
    }

    if (!propRes || propRes.error) {
      if (propRes?.error?.code !== 'InputValidationFailed') {
        // Retry with symbol if underlying_symbol is not recognized
        propRes = await this.requestAuth({
          ...baseProposal,
          symbol: asset
        });
      }
    }

    if (propRes && propRes.error) {
      throw new Error(propRes.error.message || 'Proposal failed');
    }

    const prop = propRes?.proposal;
    if (!prop || !prop.id) {
      throw new Error('Invalid proposal response from Deriv');
    }

    // Step 2: Buy
    const buyRes = await this.requestAuth({
      buy: prop.id,
      price: prop.ask_price
    });

    if (buyRes && buyRes.error) {
      throw new Error(buyRes.error.message || 'Buy order failed');
    }

    const buy = buyRes.buy;
    return {
      status: 'ok',
      id: String(buy.contract_id),
      stake: Number(buy.buy_price),
      payout: Number(buy.payout),
      msg: 'Trade placed successfully'
    };
  }

  public async getTradeResult(contractId: string, timeoutSec = 90): Promise<any> {
    const safeTimeout = Math.max(25, Number(timeoutSec) || 30);
    const end = Date.now() + (safeTimeout * 1000);
    while (Date.now() < end) {
      try {
        if (!this.tradable) {
          await this.ensureAuthConnected(10000);
        }
        const res = await this.requestAuth({
          proposal_open_contract: 1,
          contract_id: Number(contractId)
        });
        if (res.proposal_open_contract) {
          const c = res.proposal_open_contract;
          if (c.is_sold || ['won', 'lost'].includes(c.status)) {
            const pnl = Number(c.profit || 0);
            const result = c.status === 'won' ? 'win' : c.status === 'lost' ? 'loss' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'draw';
            return {
              status: 'ok',
              result,
              profit: pnl
            };
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    return { status: 'error', msg: 'Trade result timeout' };
  }
}

export const derivBridge = new DerivBridge();
