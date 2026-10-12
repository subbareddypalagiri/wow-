'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  Database = require('./sqlite-adapter');
}
const cfg = require('./config');
const PRICES = require('./prices.json').models;
const PROVIDERS = require('./providers.json');
const NETWORKS = Object.fromEntries(Object.entries(require('./networks.json')).filter(([k]) => !k.startsWith('_')));

/* ---------------- database ---------------- */
const db = new Database(cfg.DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(uid TEXT PRIMARY KEY, created INTEGER, balance_mc INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, delta_mc INTEGER, kind TEXT, ref TEXT, usd_micro INTEGER DEFAULT 0, meta TEXT, ts INTEGER, UNIQUE(kind, ref));
CREATE TABLE IF NOT EXISTS usage(req TEXT PRIMARY KEY, uid TEXT, model TEXT, in_tok INTEGER, out_tok INTEGER, cost_usd_micro INTEGER, charged_mc INTEGER, estimated INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS revenue(network TEXT, tx TEXT, uid TEXT, kind TEXT, payout_usd_micro INTEGER, credited_mc INTEGER, status TEXT, ts INTEGER, PRIMARY KEY(network, tx));
`);
const getUser = db.prepare('SELECT * FROM users WHERE uid=?');
const insUser = db.prepare('INSERT OR IGNORE INTO users(uid,created,balance_mc) VALUES(?,?,0)');
const insLedger = db.prepare('INSERT OR IGNORE INTO ledger(uid,delta_mc,kind,ref,usd_micro,meta,ts) VALUES(?,?,?,?,?,?,?)');
const addBal = db.prepare('UPDATE users SET balance_mc=balance_mc+? WHERE uid=?');

/** Every balance change goes through here. Same (kind, ref) twice is a no-op, which makes postbacks idempotent. */
const post = (uid, delta, kind, ref, usdMicro = 0, meta = '') =>
  db.transaction(() => {
    const r = insLedger.run(uid, delta, kind, ref, usdMicro, meta, Date.now());
    if (!r.changes) return false;
    addBal.run(delta, uid);
    return true;
  })();

const hold = (uid, mc, ref) =>
  db.transaction(() => {
    if (getUser.get(uid).balance_mc < mc) return false;
    insLedger.run(uid, -mc, 'hold', ref, 0, '', Date.now());
    addBal.run(-mc, uid);
    return true;
  })();

/* ---------------- money math ---------------- */
const EPS = 1e-9;
const costUsd = (m, inTok, outTok) => (inTok * m.in + outTok * m.out) / 1e6;
const chargeMc = (m, inTok, outTok) =>
  Math.max(cfg.MIN_CHARGE_MC, Math.ceil((costUsd(m, inTok, outTok) * cfg.MARKUP) / cfg.CREDIT_USD * 1000 - EPS));
const earnMc = (payoutUsd) => Math.max(0, Math.floor((payoutUsd * cfg.USER_SHARE) / cfg.CREDIT_USD * 1000 + EPS));
const micro = (usd) => Math.round(usd * 1e6);
const cr = (mc) => Math.round(mc) / 1000;

/* ---------------- sessions ---------------- */
const sign = (uid) => crypto.createHmac('sha256', cfg.SESSION_SECRET).update(uid).digest('hex').slice(0, 32);
const safeEq = (a, b) => { a = Buffer.from(String(a).toLowerCase()); b = Buffer.from(String(b).toLowerCase()); return a.length === b.length && crypto.timingSafeEqual(a, b); };
function auth(req, res, next) {
  const [uid, sig] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  if (!uid || !sig || !/^[a-f0-9]{32}$/.test(uid) || !safeEq(sig, sign(uid)) || !getUser.get(uid)) return res.status(401).json({ error: 'unauthorized' });
  req.uid = uid;
  next();
}
const hits = new Map();
const limited = (key, max, windowMs) => {
  const now = Date.now(), arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  return arr.length > max;
};

/* ---------------- app ---------------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '300kb' }));
app.use(express.urlencoded({ extended: false }));
if (process.env.CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/session', (req, res) => {
  if (limited('ip:' + req.ip, 20, 3600e3)) return res.status(429).json({ error: 'too_many_sessions' });
  const uid = crypto.randomBytes(16).toString('hex');
  insUser.run(uid, Date.now());
  if (cfg.SIGNUP_BONUS_CREDITS > 0) post(uid, Math.round(cfg.SIGNUP_BONUS_CREDITS * 1000), 'bonus', 'signup:' + uid, 0, 'marketing cost');
  res.json({ uid, token: uid + '.' + sign(uid) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ uid: req.uid, credits: cr(getUser.get(req.uid).balance_mc), creditUsd: cfg.CREDIT_USD });
});

const providerReady = (p) => cfg.DEV_MODE || !!process.env[PROVIDERS[p]?.keyEnv];
app.get('/api/models', (req, res) => {
  const list = Object.entries(PRICES)
    .filter(([, m]) => m.in != null && m.out != null && providerReady(m.provider))
    .map(([id, m]) => ({ id, label: m.label || id, group: m.group, estCredits: Math.ceil(chargeMc(m, 1000, 500) / 1000) }));
  res.json({ models: list });
});

app.get('/api/offers', auth, (req, res) => {
  const out = [];
  for (const [id, n] of Object.entries(NETWORKS)) {
    if (!cfg.DEV_MODE && !process.env[n.secretEnv]) continue;
    const est = n.kind === 'ad'
      ? { text: '~' + Math.floor(cr(earnMc(n.fixedPayoutUsd ?? cfg.AD_PAYOUT_USD))) + ' credits per ad, max ' + cfg.AD_DAILY_CAP + ' a day' }
      : { text: 'up to ' + Math.floor(cr(earnMc(n.maxPayoutUsd || 1))) + ' credits per survey' };
    out.push({ id, label: n.label, kind: n.kind, url: n.wallUrl.replace('{uid}', encodeURIComponent(req.uid)), est: est.text });
  }
  res.json({ offers: out, creditUsd: cfg.CREDIT_USD, userShare: cfg.USER_SHARE });
});

/* ---------------- earning: server-to-server postbacks ---------------- */
function creditRevenue(net, n, uid, tx, payoutUsd, reversed) {
  const ref = net + ':' + tx;
  const existing = db.prepare('SELECT * FROM revenue WHERE network=? AND tx=?').get(net, tx);
  if (reversed) {
    if (existing && existing.status === 'ok') {
      db.transaction(() => {
        db.prepare("UPDATE revenue SET status='reversed' WHERE network=? AND tx=?").run(net, tx);
        post(uid, -existing.credited_mc, 'reversal', ref, -existing.payout_usd_micro, 'network reversed');
      })();
      return { status: 'reversed' };
    }
    if (!existing) db.prepare("INSERT INTO revenue VALUES(?,?,?,?,?,?,?,?)").run(net, tx, uid, n.kind, 0, 0, 'reversed', Date.now());
    return { status: 'ignored' };
  }
  if (existing) return { status: 'duplicate' };
  let mc = earnMc(payoutUsd);
  if (n.kind === 'ad') {
    const since = Date.now() - 864e5;
    const c = db.prepare("SELECT COUNT(*) c FROM revenue WHERE uid=? AND kind='ad' AND ts>? AND credited_mc>0").get(uid, since).c;
    if (c >= cfg.AD_DAILY_CAP) mc = 0; // you were still paid, the user just hit the daily cap
  }
  db.transaction(() => {
    db.prepare('INSERT INTO revenue VALUES(?,?,?,?,?,?,?,?)').run(net, tx, uid, n.kind, micro(payoutUsd), mc, 'ok', Date.now());
    if (mc > 0) post(uid, mc, 'earn', ref, micro(payoutUsd), net);
  })();
  return { status: 'credited', credits: cr(mc) };
}

function fillTemplate(t, q, secret, map) {
  return t.replace(/\{(\w+)\}/g, (_, k) => (k === 'secret' ? secret : q[map[k] || k] ?? ''));
}
function verifySig(n, q, secret) {
  const s = n.sig;
  if (!s) return false;
  const msg = fillTemplate(s.template, q, s.hmac ? '' : secret, n.params);
  const h = s.hmac ? crypto.createHmac(s.algo, secret).update(msg).digest('hex') : crypto.createHash(s.algo).update(msg).digest('hex');
  return !!q[s.param] && safeEq(h, q[s.param]);
}

app.all('/postback/:net', (req, res) => {
  const n = NETWORKS[req.params.net];
  if (!n) return res.status(404).send('unknown network');
  const secret = process.env[n.secretEnv];
  if (!secret) return res.status(503).send('network not configured');
  const q = { ...req.query, ...req.body };
  if (!verifySig(n, q, secret)) return res.status(403).send('bad signature');
  const uid = q[n.params.uid], tx = q[n.params.tx];
  if (!uid || !tx || !getUser.get(uid)) return res.status(200).send('ignored');
  const status = String(q[n.params.status] ?? '');
  const reversed = (n.statusReversed || []).includes(status);
  if (!reversed && !(n.statusOk || []).includes(status)) return res.status(200).send('ignored');
  let payout = n.kind === 'ad' && n.params.payout == null ? (n.fixedPayoutUsd ?? cfg.AD_PAYOUT_USD) : parseFloat(q[n.params.payout]) * (n.payoutScale ?? 1);
  if (n.fixedPayoutUsd != null && n.kind === 'ad') payout = n.fixedPayoutUsd;
  if (!Number.isFinite(payout) || payout < 0) return res.status(400).send('bad payout');
  res.send(JSON.stringify(creditRevenue(req.params.net, n, uid, String(tx), payout, reversed)));
});

if (cfg.DEV_MODE) {
  app.get('/dev/ping', (req, res) => res.json({ dev: true }));
  // Local testing only. Pretends a network paid you `payoutUsd`.
  app.post('/dev/earn', auth, (req, res) => {
    const n = { kind: req.body.kind === 'ad' ? 'ad' : 'survey' };
    const payout = Number(req.body.payoutUsd) || (n.kind === 'ad' ? cfg.AD_PAYOUT_USD : 0.5);
    res.json(creditRevenue('dev', n, req.uid, 'dev-' + crypto.randomUUID(), payout, false));
  });
}

/* ---------------- spending: metered OpenAI-compatible proxy ---------------- */
app.post('/api/chat/completions', auth, async (req, res) => {
  const { model, messages } = req.body || {};
  const m = PRICES[model];
  if (!m || m.in == null || m.out == null) return res.status(400).json({ error: 'model_unavailable' });
  const prov = PROVIDERS[m.provider];
  const baseUrl = process.env[m.provider.toUpperCase() + '_BASE_URL'] || prov.base;
  const key = process.env[prov.keyEnv] || (cfg.DEV_MODE ? 'dev' : '');
  if (!key) return res.status(503).json({ error: 'provider_not_configured' });
  if (!Array.isArray(messages) || !messages.length || messages.length > 80) return res.status(400).json({ error: 'bad_messages' });
  if (limited('chat:' + req.uid, cfg.RATE_PER_MIN, 60e3)) return res.status(429).json({ error: 'slow_down' });

  const clean = messages.map((x) => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content ?? '') }));
  const inEst = Math.ceil(JSON.stringify(clean).length / 3);
  const maxOut = Math.min(m.maxOut || cfg.MAX_OUT_TOKENS, 8000);
  const holdMc = chargeMc(m, inEst, maxOut);
  const reqId = crypto.randomUUID();
  if (!hold(req.uid, holdMc, reqId)) {
    return res.status(402).json({ error: 'insufficient_credits', needCredits: cr(holdMc), haveCredits: cr(getUser.get(req.uid).balance_mc) });
  }

  const body = { model, messages: clean, stream: true, stream_options: { include_usage: true } };
  body[m.tok || 'max_tokens'] = maxOut;
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let chars = 0, usage = null, started = false, ok = false;
  try {
    const r = await fetch(baseUrl + '/chat/completions', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
    if (!r.ok) { console.error('upstream', model, r.status); return res.status(502).json({ error: 'upstream_error', status: r.status }); }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    started = true;
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      res.write(chunk);
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        if (!l.startsWith('data:')) continue;
        const d = l.slice(5).trim();
        if (d === '[DONE]') continue;
        try { const j = JSON.parse(d); if (j.usage) usage = j.usage; const t = j.choices?.[0]?.delta?.content; if (t) chars += t.length; } catch {}
      }
    }
    ok = true;
  } catch (e) {
    if (e.name !== 'AbortError') console.error('stream error', model, e.message);
  } finally {
    settle();
    if (started) res.end();
  }

  function settle() {
    let inTok, outTok, estimated = 0;
    if (usage && usage.prompt_tokens != null) { inTok = usage.prompt_tokens; outTok = usage.completion_tokens || 0; }
    else if (chars > 0) { inTok = inEst; outTok = Math.ceil(chars / 3.5); estimated = 1; }
    else { post(req.uid, holdMc, 'refund', reqId, 0, ok ? 'empty' : 'failed'); return; }
    const real = costUsd(m, inTok, outTok);
    const charge = Math.min(holdMc, chargeMc(m, inTok, outTok)); // never take more than was held
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO usage VALUES(?,?,?,?,?,?,?,?,?)').run(reqId, req.uid, model, inTok, outTok, micro(real), charge, estimated, Date.now());
      if (holdMc - charge > 0) post(req.uid, holdMc - charge, 'refund', reqId, 0, 'unused hold');
    })();
  }
});

/* ---------------- the books ---------------- */
app.get('/api/admin/summary', (req, res) => {
  if (!cfg.ADMIN_KEY || !safeEq(req.headers['x-admin-key'] || '', cfg.ADMIN_KEY)) return res.status(401).json({ error: 'unauthorized' });
  const one = (sql) => Object.values(db.prepare(sql).get())[0] || 0;
  const revenue = one("SELECT SUM(payout_usd_micro) FROM revenue WHERE status='ok'") / 1e6;
  const providerCost = one('SELECT SUM(cost_usd_micro) FROM usage') / 1e6;
  const outstanding = one('SELECT SUM(balance_mc) FROM users WHERE balance_mc>0') / 1000;
  const owedToServe = (outstanding * cfg.CREDIT_USD) / cfg.MARKUP;
  const bonus = one("SELECT SUM(delta_mc) FROM ledger WHERE kind='bonus'") / 1000;
  res.json({
    revenue_usd: revenue,
    provider_cost_usd: providerCost,
    outstanding_credits: outstanding,
    est_cost_to_serve_outstanding_usd: owedToServe,
    bonus_credits_issued: bonus,
    net_usd: revenue - providerCost - owedToServe - bonus * cfg.CREDIT_USD / cfg.MARKUP,
    users: one('SELECT COUNT(*) FROM users'),
    estimated_usage_rows: one('SELECT COUNT(*) FROM usage WHERE estimated=1'),
  });
});

if (require.main === module) app.listen(cfg.PORT, () => console.log('Ember server on :' + cfg.PORT + (cfg.DEV_MODE ? ' (DEV MODE)' : '')));
module.exports = { app, db };
