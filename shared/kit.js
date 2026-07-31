/* ============================================================
   shared/kit.js
   Shared by every game in the library. The overlay (browser
   source) and the control panel (OBS custom browser dock) both
   load this. They must be served from the SAME ORIGIN.

   Verified in OBS: docks and browser sources share both
   localStorage and BroadcastChannel, so settings push live.
   ============================================================ */
(function (root) {
"use strict";

/* ---------- defaults ----------------------------------------
   This shape IS the overlay's CONFIG object. Keep them identical.
   ------------------------------------------------------------ */
const DEFAULTS = {
  chatroomId: 0,
  channelName: "",

  rows: 12,
  slotValues: [-1, -2, 5, 10, 25, 50, 100],   // centre outward, mirrored

  palette: {
    white:"#FFFFFF", red:"#FF3B4E", blue:"#3B9BFF", green:"#53FC18",
    orange:"#FA5A1E", yellow:"#FFD93B", pink:"#FF2D8E", purple:"#A855F7",
    cyan:"#22D3EE", gold:"#F0B429", mint:"#5BE9B9", coral:"#FF7A6B",
  },
  defaultColor: "#FFFFFF",

  board: {
    maxActive:300, maxQueue:3000, releasePerFrame:4,
    /* Gap between spawns so a multi-ball !drop trickles out instead of
       arriving as one clump. Ignored once the queue is deep enough that a
       raid would otherwise take minutes to drain. */
    releaseGapMs: 130,
  },

  economy: {
    freePlay:true, startingBalls:3, maxPerDrop:5, cooldownSec:0,
    watchEveryMin:10, watchBalls:1, onSub:5, onGiftSub:3,

    /* "command" = only !drop plays. "any" = every chat message drops one
       ball, and !drop still works for multi-ball. */
    dropMode: "command",
    messageCooldownSec: 5,   // any-mode rate limit, hard floor of 2
    freeMessages: true,      // plain messages don't spend credits
  },
  display: { background: "vignette" },   // "vignette" | "transparent"
  useAvatars: false,         // needs OAuth — Pusher gives no profile picture

  /* gravity is the only physics value worth exposing — the rest is
     calibrated against a binomial distribution and shouldn't be touched */
  physics: { gravity:0.90, restitution:0.50, damping:0.990, jitter:0.45, maxVx:0.75, substeps:4 },

  idleCtaAfterSec: 14,
  labelThreshold: 45,
  targetFps: 40,
  title: "PLINKO",
};

/* ---------- storage ----------------------------------------- */
const Store = (() => {
  let ok = true;
  try { localStorage.setItem("__t","1"); localStorage.removeItem("__t"); } catch(e){ ok = false; }
  const mem = {};
  return {
    available: ok,
    get(k,f){ try { const v = ok?localStorage.getItem(k):mem[k]; return v==null?f:JSON.parse(v); } catch(e){ return f; } },
    set(k,v){ const s=JSON.stringify(v); try { if(ok) localStorage.setItem(k,s); else mem[k]=s; } catch(e){ mem[k]=s; } },
  };
})();

/* ---------- deep merge so new keys inherit defaults ---------- */
function merge(base, over){
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
  if (base && typeof base === "object"){
    const out = {};
    for (const k of Object.keys(base)) out[k] = merge(base[k], over ? over[k] : undefined);
    if (over) for (const k of Object.keys(over)) if (!(k in out)) out[k] = over[k];
    return out;
  }
  return over === undefined ? base : over;
}
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------- settings ---------------------------------------- */
const KEY = "plinko.settings";

const Settings = {
  data: merge(DEFAULTS, Store.get(KEY, null)),
  _subs: [],

  get(path){ return path.split(".").reduce((o,k)=> o==null?o:o[k], this.data); },

  set(path, value){
    const keys = path.split(".");
    let o = this.data;
    for (let i=0;i<keys.length-1;i++) o = o[keys[i]];
    o[keys[keys.length-1]] = value;
    this.commit();
  },

  replace(obj){ this.data = merge(DEFAULTS, obj); this.commit(); },
  reset(){ this.replace(clone(DEFAULTS)); },

  commit(){
    Store.set(KEY, this.data);
    Bridge.send("settings", this.data);
    this._subs.forEach(fn => fn(this.data));
  },

  onChange(fn){ this._subs.push(fn); },

  /* applied when the peer changed something — no re-broadcast */
  _adopt(data){
    this.data = merge(DEFAULTS, data);
    Store.set(KEY, this.data);
    this._subs.forEach(fn => fn(this.data));
  },
};

/* ---------- bridge ------------------------------------------ */
const Bridge = {
  _bc:null, _handlers:{},

  init(){
    try { this._bc = new BroadcastChannel("plinko"); } catch(e){ this._bc = null; }
    if (this._bc) this._bc.onmessage = ev => this._dispatch(ev.data);

    window.addEventListener("storage", ev => {
      if (ev.key === KEY && ev.newValue){
        try { Settings._adopt(JSON.parse(ev.newValue)); } catch(e){}
      }
      if (ev.key === "plinko.bus" && ev.newValue){
        try { this._dispatch(JSON.parse(ev.newValue)); } catch(e){}
      }
    });
    return this;
  },

  /* Transient telemetry: BroadcastChannel only, no storage write. For
     anything high-rate where a late-joining context doesn't need to catch up. */
  sendLive(type, payload){
    if (!this._bc) return false;
    try { this._bc.postMessage({ type, payload, at: Date.now() }); return true; }
    catch(e){ return false; }
  },

  send(type, payload){
    const msg = { type, payload, at:Date.now(), id:Math.random() };
    if (this._bc){ try { this._bc.postMessage(msg); } catch(e){} }
    try { localStorage.setItem("plinko.bus", JSON.stringify(msg)); } catch(e){}
  },

  on(type, fn){ (this._handlers[type] = this._handlers[type] || []).push(fn); return this; },

  _dispatch(msg){
    if (!msg || !msg.type) return;
    if (msg.type === "settings"){ Settings._adopt(msg.payload); return; }
    (this._handlers[msg.type] || []).forEach(fn => fn(msg.payload));
  },
};

/* ---------- economy (overlay side only) --------------------- */
const todayKey = () => new Date().toISOString().slice(0,10);

const Economy = {
  users:     Store.get("plinko.users", {}),
  allTime:   Store.get("plinko.allTime", {}),
  day:       Store.get("plinko.day", todayKey()),
  dayScores: Store.get("plinko.dayScores", {}),
  dayDrops:  Store.get("plinko.dayDrops", 0),
  dayBest:   Store.get("plinko.dayBest", 0),
  /* Identity is the lowercased name; this keeps the casing chat shows. */
  display:   Store.get("plinko.display", {}),
  onReset: null,
  _dirty: false,

  rollDayIfNeeded(){
    const t = todayKey();
    if (this.day !== t){
      this.day=t; this.dayScores={}; this.dayDrops=0; this.dayBest=0;
      if (this.onReset) this.onReset();
      this.save();
    }
  },

  /* Kick sends display casing, mods type whatever they like. Fold every
     record onto the lowercase key so one person is one person. */
  normalizeKeys(){
    const foldNum = o => {
      const out={};
      for (const k of Object.keys(o)) { const l=k.toLowerCase(); out[l]=(out[l]||0)+o[k]; }
      return out;
    };
    const foldUser = o => {
      const out={};
      for (const k of Object.keys(o)){
        const l=k.toLowerCase(), v=o[k]||{};
        if (!out[l]) out[l]={balls:0,last:0,color:null};
        out[l].balls += v.balls||0;
        out[l].last   = Math.max(out[l].last, v.last||0);
        out[l].color  = out[l].color || v.color || null;
        if (k!==l && !this.display[l]) this.display[l]=k;
      }
      return out;
    };
    this.users     = foldUser(this.users);
    this.allTime   = foldNum(this.allTime);
    this.dayScores = foldNum(this.dayScores);
  },

  /* Remember how a name is spelled, without changing identity. */
  seen(name){
    const k = String(name).toLowerCase();
    if (this.display[k] !== name){ this.display[k] = name; this.save(); }
    return k;
  },
  shown(key){ return this.display[key] || key; },

  user(n){
    n = String(n).toLowerCase();
    if (!this.users[n]) this.users[n] = { balls:Settings.get("economy.startingBalls"), last:0, color:Settings.get("defaultColor") };
    if (!this.users[n].color) this.users[n].color = Settings.get("defaultColor");
    return this.users[n];
  },

  setColor(n, hex){ this.user(n).color = hex; this.save(); },

  canDrop(n, c, opts){
    n = String(n).toLowerCase();
    opts = opts || {};
    this.rollDayIfNeeded();
    const u = this.user(n);
    const cd = opts.cooldownSec != null ? opts.cooldownSec : Settings.get("economy.cooldownSec");
    const wait = cd*1000 - (Date.now() - u.last);
    if (wait > 0) return { ok:false, why:`${n} on cooldown · ${Math.ceil(wait/1000)}s`, quiet:!!opts.quiet };
    const free = opts.free || Settings.get("economy.freePlay");
    if (!free && u.balls < c)
      return { ok:false, why:`${n} needs ${c} balls, has ${u.balls}`, quiet:!!opts.quiet };
    return { ok:true };
  },

  spend(n, c, opts){
    n = String(n).toLowerCase();
    opts = opts || {};
    const u = this.user(n);
    u.last = Date.now();
    const free = opts.free || Settings.get("economy.freePlay");
    if (!free) u.balls -= c;
    this.save();
  },

  grant(n, x){
    n = String(n).toLowerCase(); this.user(n).balls += x; this.save(); },

  award(n, pts){
    n = String(n).toLowerCase();
    this.rollDayIfNeeded();
    this.dayScores[n] = (this.dayScores[n]||0) + pts;
    this.allTime[n]   = (this.allTime[n]||0) + pts;
    this.dayDrops++;
    if (pts > this.dayBest) this.dayBest = pts;
    this.save();
  },

  resetDay(){
    this.dayScores={}; this.dayDrops=0; this.dayBest=0;
    if (this.onReset) this.onReset();
    this.save();
  },
  resetAllTime(){ this.allTime={}; this.save(); },
  resetCredits(){ this.users={}; this.save(); },

  top(which, n=10){
    const src = which === "all" ? this.allTime : this.dayScores;
    return Object.entries(src).sort((a,b)=>b[1]-a[1]).slice(0,n);
  },

  /* writes are debounced — a 300-ball raid must not fire six
     synchronous serializations per landing */
  save(){ this._dirty = true; },
  flush(){
    if (!this._dirty) return;
    this._dirty = false;
    Store.set("plinko.users",this.users);         Store.set("plinko.allTime",this.allTime);
    Store.set("plinko.day",this.day);             Store.set("plinko.dayScores",this.dayScores);
    Store.set("plinko.dayDrops",this.dayDrops);   Store.set("plinko.dayBest",this.dayBest);
    Store.set("plinko.display",this.display);
  },
};

/* ---------- helpers ----------------------------------------- */
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function hexA(hex, a){
  const h = String(hex).replace("#","");
  const n = parseInt(h.length===3 ? h.split("").map(c=>c+c).join("") : h, 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}
function shade(hex, amt){
  const h = String(hex).replace("#","");
  const n = parseInt(h.length===3 ? h.split("").map(c=>c+c).join("") : h, 16);
  const f = v => Math.max(0, Math.min(255, Math.round(v + 255*amt)));
  return `rgb(${f((n>>16)&255)},${f((n>>8)&255)},${f(n&255)})`;
}

/* mirrored slot values + colour per value, tolerating negatives */
function buildSlotColours(values, ramp, negRamp){
  const pos = values.filter(v=>v>0);
  const mx = pos.length?Math.max(...pos):1, mn = pos.length?Math.min(...pos):1;
  const negs = [...new Set(values.filter(v=>v<=0))].sort((a,b)=>a-b);
  const map = {};
  for (const v of values){
    if (v<=0){
      const i = negs.indexOf(v);
      const k = negs.length<2 ? negRamp.length-1
              : Math.round((1 - i/(negs.length-1))*(negRamp.length-1));
      map[v] = negRamp[k];
    } else {
      const t = (Math.log(v)-Math.log(mn))/Math.max(Math.log(mx)-Math.log(mn),1e-4);
      map[v] = ramp[Math.min(ramp.length-1, Math.round(t*(ramp.length-1)))];
    }
  }
  return map;
}

/* binomial landing odds for a given row count */
function slotOdds(rows){
  const c=[]; let t=0;
  for (let k=0;k<=rows;k++){
    let x=1; for (let i=0;i<k;i++) x = x*(rows-i)/(i+1);
    c.push(x); t+=x;
  }
  return c.map(x=>x/t);
}

root.Plinko = { DEFAULTS, Store, Settings, Bridge, Economy,
                esc, hexA, shade, merge, clone, buildSlotColours, slotOdds };

})(typeof window !== "undefined" ? window : globalThis);
