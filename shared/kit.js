/* ============================================================
   plinko-shared.js
   Shared by the overlay (browser source) and the control panel
   (OBS custom browser dock). Both must be served from the SAME
   ORIGIN or they cannot see each other.

   This file is the reusable half of the kit — the next game in
   the library should be able to take it unchanged.
   ============================================================ */
(function (root) {
"use strict";

/* ---------- defaults ---------------------------------------- */
const DEFAULTS = {
  channel: {
    chatroomId: 0,
    label: "",
  },
  board: {
    rows: 12,
    slotValues: [1, 2, 5, 10, 25, 50, 100],   // centre outward, mirrored
    maxActive: 300,                            // balls on the board at once
    maxQueue: 3000,                            // pending drops before we refuse
    releasePerFrame: 4,                        // how fast the queue feeds in
  },
  economy: {
    freePlay: true,
    startingBalls: 3,
    maxPerDrop: 5,
    cooldownSec: 30,
    watchEveryMin: 10,
    watchBalls: 1,
    onSub: 5,
    onGiftSub: 3,
  },
  prizes: [
    { atLeast: 100, text: "Song request" },
    { atLeast: 50,  text: "Pick next map" },
    { atLeast: 25,  text: "Shoutout" },
  ],
  display: {
    showLeaderboard: true,
    showFeed: true,
    showPrizes: true,
    showStats: true,
    idleCtaSec: 14,
    leaderboardMode: "day",   // day | all
    title: "PLINKO",
  },
};

/* ---------- storage ----------------------------------------- */
const Store = (() => {
  let ok = true;
  try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); }
  catch (e) { ok = false; }
  const mem = {};
  return {
    available: ok,
    get(k, f) {
      try { const v = ok ? localStorage.getItem(k) : mem[k];
            return v == null ? f : JSON.parse(v); }
      catch (e) { return f; }
    },
    set(k, v) {
      const s = JSON.stringify(v);
      try { if (ok) localStorage.setItem(k, s); else mem[k] = s; }
      catch (e) { mem[k] = s; }
    },
  };
})();

/* ---------- deep merge so new settings pick up defaults ------ */
function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
  if (base && typeof base === "object") {
    const out = {};
    for (const k of Object.keys(base))
      out[k] = merge(base[k], over ? over[k] : undefined);
    if (over) for (const k of Object.keys(over)) if (!(k in out)) out[k] = over[k];
    return out;
  }
  return over === undefined ? base : over;
}

/* ---------- settings ---------------------------------------- */
const KEY = "plinko.settings";

const Settings = {
  data: merge(DEFAULTS, Store.get(KEY, null)),
  _subs: [],

  all() { return this.data; },
  get(path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), this.data);
  },
  set(path, value, broadcast = true) {
    const keys = path.split(".");
    let o = this.data;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
    this.commit(broadcast);
  },
  replace(obj, broadcast = true) {
    this.data = merge(DEFAULTS, obj);
    this.commit(broadcast);
  },
  reset() { this.replace(JSON.parse(JSON.stringify(DEFAULTS))); },
  commit(broadcast = true) {
    Store.set(KEY, this.data);
    if (broadcast) Bridge.send("settings", this.data);
    this._subs.forEach(fn => fn(this.data));
  },
  onChange(fn) { this._subs.push(fn); },
  _adopt(data) {
    this.data = merge(DEFAULTS, data);
    Store.set(KEY, this.data);
    this._subs.forEach(fn => fn(this.data));
  },
};

/* ---------- bridge ------------------------------------------
   BroadcastChannel is instant; the storage event is the belt-
   and-braces fallback when BC isn't available in the context.
   ------------------------------------------------------------ */
const Bridge = {
  _bc: null,
  _handlers: {},

  init() {
    try { this._bc = new BroadcastChannel("plinko"); } catch (e) { this._bc = null; }
    if (this._bc) this._bc.onmessage = (ev) => this._dispatch(ev.data);

    window.addEventListener("storage", (ev) => {
      if (ev.key === KEY && ev.newValue) {
        try { Settings._adopt(JSON.parse(ev.newValue)); } catch (e) {}
      }
      if (ev.key === "plinko.bus" && ev.newValue) {
        try { this._dispatch(JSON.parse(ev.newValue)); } catch (e) {}
      }
    });
    return this;
  },

  send(type, payload) {
    const msg = { type, payload, at: Date.now(), id: Math.random() };
    if (this._bc) { try { this._bc.postMessage(msg); } catch (e) {} }
    try { localStorage.setItem("plinko.bus", JSON.stringify(msg)); } catch (e) {}
  },

  on(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); return this; },

  _dispatch(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === "settings") { Settings._adopt(msg.payload); return; }
    (this._handlers[msg.type] || []).forEach(fn => fn(msg.payload));
  },
};

/* ---------- economy ----------------------------------------- */
const todayKey = () => new Date().toISOString().slice(0, 10);

const Economy = {
  users:     Store.get("plinko.users", {}),
  allTime:   Store.get("plinko.allTime", {}),
  day:       Store.get("plinko.day", todayKey()),
  dayScores: Store.get("plinko.dayScores", {}),
  dayDrops:  Store.get("plinko.dayDrops", 0),
  dayBest:   Store.get("plinko.dayBest", 0),
  onReset: null,

  reload() {
    this.users     = Store.get("plinko.users", {});
    this.allTime   = Store.get("plinko.allTime", {});
    this.day       = Store.get("plinko.day", todayKey());
    this.dayScores = Store.get("plinko.dayScores", {});
    this.dayDrops  = Store.get("plinko.dayDrops", 0);
    this.dayBest   = Store.get("plinko.dayBest", 0);
  },

  rollDayIfNeeded() {
    const t = todayKey();
    if (this.day !== t) {
      this.day = t; this.dayScores = {}; this.dayDrops = 0; this.dayBest = 0;
      if (this.onReset) this.onReset();
      this.save();
    }
  },

  user(n) {
    if (!this.users[n]) this.users[n] = { balls: Settings.get("economy.startingBalls"), last: 0 };
    return this.users[n];
  },

  canDrop(n, c) {
    this.rollDayIfNeeded();
    const u = this.user(n);
    const wait = Settings.get("economy.cooldownSec") * 1000 - (Date.now() - u.last);
    if (wait > 0) return { ok: false, why: `${n} on cooldown · ${Math.ceil(wait / 1000)}s` };
    if (!Settings.get("economy.freePlay") && u.balls < c)
      return { ok: false, why: `${n} needs ${c} balls, has ${u.balls}` };
    return { ok: true };
  },

  spend(n, c) {
    const u = this.user(n);
    u.last = Date.now();
    if (!Settings.get("economy.freePlay")) u.balls -= c;
    this.save();
  },

  grant(n, x) { this.user(n).balls += x; this.save(); },

  award(n, pts) {
    this.rollDayIfNeeded();
    this.dayScores[n] = (this.dayScores[n] || 0) + pts;
    this.allTime[n]   = (this.allTime[n] || 0) + pts;
    this.dayDrops++;
    if (pts > this.dayBest) this.dayBest = pts;
    this.save();
  },

  resetDay() {
    this.dayScores = {}; this.dayDrops = 0; this.dayBest = 0;
    if (this.onReset) this.onReset();
    this.save();
  },
  resetAll() { this.allTime = {}; this.save(); },
  resetCredits() { this.users = {}; this.save(); },

  top(which, n = 10) {
    const src = which === "all" ? this.allTime : this.dayScores;
    return Object.entries(src).sort((a, b) => b[1] - a[1]).slice(0, n);
  },

  save() {
    Store.set("plinko.users", this.users);
    Store.set("plinko.allTime", this.allTime);
    Store.set("plinko.day", this.day);
    Store.set("plinko.dayScores", this.dayScores);
    Store.set("plinko.dayDrops", this.dayDrops);
    Store.set("plinko.dayBest", this.dayBest);
  },
};

/* ---------- helpers ----------------------------------------- */
const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function hexA(hex, a) {
  const h = String(hex).replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* mirrored slot values + a log-scaled heat colour per value */
function buildSlots(slotValues, ramp) {
  const half = slotValues.slice(1);
  const values = [...half.slice().reverse(), slotValues[0], ...half];
  const mx = Math.max(...values), mn = Math.min(...values);
  const colorFor = {};
  for (const v of values) {
    const t = (Math.log(v) - Math.log(mn)) / Math.max(Math.log(mx) - Math.log(mn), 1e-4);
    colorFor[v] = ramp[Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1)))];
  }
  const heat = (v) => {
    if (colorFor[v]) return colorFor[v];
    const sorted = values.slice().sort((a, b) => a - b);
    let best = sorted[0];
    for (const k of sorted) if (k <= v) best = k;
    return colorFor[best] || ramp[0];
  };
  return { values, heat };
}

/* binomial landing odds — what the panel shows the streamer */
function slotOdds(rows) {
  const c = []; let t = 0;
  for (let k = 0; k <= rows; k++) {
    let x = 1;
    for (let i = 0; i < k; i++) x = x * (rows - i) / (i + 1);
    c.push(x); t += x;
  }
  return c.map(x => x / t);
}

root.Plinko = { DEFAULTS, Store, Settings, Bridge, Economy, esc, hexA, buildSlots, slotOdds, merge };

})(typeof window !== "undefined" ? window : globalThis);
