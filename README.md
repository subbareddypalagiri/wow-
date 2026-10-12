# Ember server: real credits backed by real money

## The one rule
**1 credit = $0.001.** Every number below is derived from that, nothing is a made-up default.

| Event | What happens | Example |
|---|---|---|
| Survey completed | Network pays you `P` dollars. User gets `P x USER_SHARE / CREDIT_USD` credits. | You earn $0.80, user gets **400 credits** |
| Rewarded ad watched | Same formula with a low fixed estimate (`AD_PAYOUT_USD`). | $0.006 per ad, user gets **3 credits** |
| Premium message | Provider returns real token counts. User pays `cost x MARKUP / CREDIT_USD`. | gpt-4o, 1000 in + 500 out = $0.0075 x 1.25 = **9.375 credits** |

**Why you never lose money:** you keep `1 - USER_SHARE` of revenue, and the credits the user earned only buy `CREDIT_USD / MARKUP` of API cost each. Profit on each $1 of revenue is `1 - USER_SHARE / MARKUP`. With 0.5 and 1.25 that is **60 cents**. The server refuses to start if `USER_SHARE >= MARKUP`.

## Run it
```
npm install
cp .env.example .env     # fill it in, then export the variables (or use your host's env settings)
node test.js             # proves the money math against a fake provider
DEV_MODE=1 node server.js
```
Open `http://localhost:3000`. In DEV_MODE the ad page has a simulate button, so you can see credits arrive.

## Go live (checklist)
1. **Prices.** Open `prices.json` and check every number against each provider's pricing page. A model with `null` prices is switched off. Fable 5.1 and Opus 5.5 are `null` until you fill them in. GPT Astra-6 is not in the list because I do not know its API name or price.
2. **Provider keys** go in environment variables on the server only. They never reach the browser.
3. **Survey network.** Pick a survey/offerwall provider that supports server-to-server postbacks. Copy its postback parameter names and its signature rule into `networks.json` (`params`, `sig`, `statusOk`, `statusReversed`). Give it this URL: `https://YOUR-DOMAIN/postback/survey_wall_1`. The `payout` it sends must be **what the network pays you in USD**, not its own points.
4. **Ads.** Use a *rewarded* ad format that allows incentives. **Do not reward clicks or views on AdSense banner ads, Google bans that.** Put the SDK in `public/ad.html` and make the network call `/postback/ad_network_1`.
5. **Hosting.** Needs a persistent disk for the SQLite file (Fly volume, Railway volume, or a small VPS). Take daily backups of `ember.db`, it is your ledger.
6. **Watch the books:** `GET /api/admin/summary` with header `x-admin-key`. It shows revenue, real provider cost, credits still owed, and net.

## Things that will bite you if ignored
- **Ad revenue arrives late and is an average.** That is why ads use a deliberately low estimate. Each month compare your network's report to the ad rows in `revenue` and lower or raise `AD_PAYOUT_USD`.
- **Survey reversals.** Networks cancel fraud completions days later. The server takes the credits back (balance can go negative). Do not set `USER_SHARE` above 0.6 until you see your reversal rate.
- **Anonymous accounts.** Credits belong to a browser token. Clear storage and they are gone. Before real money flows, add Google sign-in.
- **Providers that omit token usage in streams.** The server then estimates from text length and flags the row (`estimated=1` in the summary). Check those rows against the provider's bill.
- **Reasoning models** (o3, gpt-5, grok-4, deepseek-reasoner) bill hidden thinking tokens. Their `maxOut` is higher in `prices.json`, so the up-front hold is larger. Unused hold is refunded.
- **Taxes, payouts, privacy policy and each network's terms** are on you. Ask an accountant before launch.
