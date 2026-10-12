'use strict';
// All money knobs live here. Change them with environment variables, not code.
const os = require('os');
const path = require('path');
const env = process.env;
const num = (k, d) => (env[k] != null && env[k] !== '' ? Number(env[k]) : d);

const isVercel = !!(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME);
const defaultDb = isVercel ? path.join(os.tmpdir(), 'ember.db') : './ember.db';

const cfg = {
  PORT: num('PORT', 3000),
  DB_PATH: env.DB_PATH || defaultDb,
  DEV_MODE: env.DEV_MODE === '1',
  SESSION_SECRET: env.SESSION_SECRET || '',
  ADMIN_KEY: env.ADMIN_KEY || '',

  // 1 credit is worth this many US dollars. Everything else is derived from it.
  CREDIT_USD: num('CREDIT_USD', 0.001),
  // Share of real publisher payout that the user receives as credits.
  USER_SHARE: num('USER_SHARE', 0.5),
  // Credits charged = real API cost x MARKUP. Must be >= USER_SHARE or you lose money.
  MARKUP: num('MARKUP', 1.25),
  MAX_OUT_TOKENS: num('MAX_OUT_TOKENS', 1500),
  MIN_CHARGE_MC: num('MIN_CHARGE_MC', 1000), // minimum charge per message, in millicredits

  // Rewarded ads pay per view and the exact figure arrives late, so use a LOW fixed estimate
  // and reconcile it against the network's real report every month.
  AD_PAYOUT_USD: num('AD_PAYOUT_USD', 0.006),
  AD_DAILY_CAP: num('AD_DAILY_CAP', 10),

  // Free credits cost YOU money. Keep 0 unless you budget for it.
  SIGNUP_BONUS_CREDITS: num('SIGNUP_BONUS_CREDITS', 0),
  RATE_PER_MIN: num('RATE_PER_MIN', 20),
};

if (!cfg.SESSION_SECRET) {
  if (cfg.DEV_MODE || isVercel) {
    cfg.SESSION_SECRET = 'ember-secret-' + (isVercel ? 'vercel' : 'dev');
  } else {
    cfg.SESSION_SECRET = 'ember-default-session-secret';
    console.warn('Warning: SESSION_SECRET not set in environment, using default.');
  }
}
if (cfg.USER_SHARE >= cfg.MARKUP) {
  console.error(`Refusing to start: USER_SHARE (${cfg.USER_SHARE}) >= MARKUP (${cfg.MARKUP}). You would lose money on every credit.`);
  process.exit(1);
}
if (cfg.USER_SHARE / cfg.MARKUP > 0.8) console.warn('Warning: more than 80% of revenue goes to API cost. Margin is thin.');

module.exports = cfg;
