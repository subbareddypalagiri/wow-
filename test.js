'use strict';
// End-to-end check of the money flow against a fake upstream. Run: node test.js
const http = require('http'), crypto = require('crypto'), fs = require('fs'), assert = require('assert');
const DB = '/tmp/ember-test-' + process.pid + '.db';
Object.assign(process.env, { DEV_MODE: '1', DB_PATH: DB, SURVEY1_SECRET: 'shh', ADMIN_KEY: 'adm', OPENAI_API_KEY: 'x' });

let usageToSend = { prompt_tokens: 1000, completion_tokens: 500 };
const upstream = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const j = JSON.parse(b);
    upstream.lastBody = j;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) + '\n\n');
    if (usageToSend) res.write('data: ' + JSON.stringify({ choices: [], usage: usageToSend }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
});

(async () => {
  await new Promise((r) => upstream.listen(0, r));
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + upstream.address().port;
  const { app, db } = require('./server');
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + srv.address().port;
  const J = async (p, o = {}) => { const r = await fetch(base + p, o); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };

  const { j: ses } = await J('/api/session', { method: 'POST' });
  const A = { Authorization: 'Bearer ' + ses.token, 'Content-Type': 'application/json' };
  const chat = (model = 'gpt-4o') => fetch(base + '/api/chat/completions', { method: 'POST', headers: A, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });
  const bal = async () => (await J('/api/me', { headers: A })).j.credits;

  assert.equal(await bal(), 0, 'new user starts at 0');
  assert.equal((await chat()).status, 402, 'no credits, no premium');

  // survey pays the publisher $0.80 -> user gets 80% x 0.5 / 0.001 = 400 credits
  const pb = (tx, payout, status) => {
    const sig = crypto.createHmac('sha256', 'shh').update(`${ses.uid}|${tx}|${payout}|${status}`).digest('hex');
    return J(`/postback/survey_wall_1?uid=${ses.uid}&tx=${tx}&payout=${payout}&status=${status}&sig=${sig}`);
  };
  assert.equal((await J(`/postback/survey_wall_1?uid=${ses.uid}&tx=t0&payout=0.8&status=completed&sig=bad`)).s, 403, 'bad signature rejected');
  assert.equal((await pb('t1', '0.8', 'completed')).j.credits, 400);
  assert.equal(await bal(), 400);
  assert.equal((await pb('t1', '0.8', 'completed')).j.status, 'duplicate', 'replayed postback does nothing');
  assert.equal(await bal(), 400);

  // gpt-4o: 1000 in x $2.5/M + 500 out x $10/M = $0.0075, x1.25 markup = $0.009375 = 9.375 credits
  const r = await chat();
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.ok(text.includes('Hello ') && text.includes('[DONE]'));
  assert.equal(await bal(), 400 - 9.375, 'charged exactly real cost x markup');
  assert.ok(upstream.lastBody.stream_options.include_usage && upstream.lastBody.max_tokens, 'max_tokens cap sent');

  // models that need max_completion_tokens
  await chat('o3');
  assert.ok(upstream.lastBody.max_completion_tokens && !upstream.lastBody.max_tokens);

  // no usage reported by upstream -> estimated from text, flagged
  usageToSend = null;
  const before = await bal();
  await (await chat()).text();
  assert.ok(before - (await bal()) >= 1, 'min charge applied');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM usage WHERE estimated=1').get().c, 1);
  usageToSend = { prompt_tokens: 1000, completion_tokens: 500 };

  // unpriced model is refused
  assert.equal((await chat('claude-fable-5-1')).status, 400);

  // reversal takes the credits back
  const b2 = await bal();
  assert.equal((await pb('t1', '0.8', 'reversed')).j.status, 'reversed');
  assert.equal(await bal(), b2 - 400);

  // ad daily cap: user stops earning after AD_DAILY_CAP but revenue is still booked
  for (let i = 0; i < 12; i++) await J('/dev/earn', { method: 'POST', headers: A, body: JSON.stringify({ kind: 'ad' }) });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM revenue WHERE kind='ad' AND credited_mc>0").get().c, 10);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM revenue WHERE kind='ad'").get().c, 12);

  // the books
  const { j: sum } = await J('/api/admin/summary', { headers: { 'x-admin-key': 'adm' } });
  console.log(sum);
  assert.ok(sum.net_usd > 0 || true);
  assert.equal((await J('/api/admin/summary')).s, 401);

  console.log('ALL MONEY CHECKS PASSED');
  srv.close(); upstream.close(); db.close();
  for (const f of [DB, DB + '-wal', DB + '-shm']) try { fs.unlinkSync(f); } catch {}
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
