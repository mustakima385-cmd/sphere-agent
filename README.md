# Sphere Agent

An autonomous economic agent built on [Unicity Sphere SDK](https://github.com/unicity-sphere/sphere-sdk). It runs on **testnet by default**. It has its own wallet/identity and can:

1. **Trade** — watch the market intents board for a coin and propose a buy/sell when the price crosses your target.
2. **Negotiate** — watch incoming DMs for counterparties replying `ACCEPT <price>` and propose a deal if the price is within your cap.
3. **Post its own offers** — publish an intent to the market board; if a counterparty DMs back `ACCEPT OFFER`, propose that deal too.

**Nothing ever sends funds automatically.** Every trade/negotiation/accepted-offer becomes a *proposed deal* sitting in a queue. You review it on the dashboard and click **Approve & send** (or **Reject**). Even on approval, the deal is checked against two hard caps before it's allowed to execute: a per-deal maximum and a rolling 24-hour total, both enforced in code (`src/approvalQueue.ts`), not just config.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:
- Leave `WALLET_MNEMONIC` blank on first run — the server generates one, prints it once to the log, and saves it to `wallet-data/`. Copy it into `.env` afterward so the same identity persists across restarts.
- `SPHERE_ORACLE_API_KEY` — for `testnet`, Unicity publishes a non-secret testnet2 key in their `sphere-sdk/.env.example`; use that to get started. Treat a mainnet key as a real secret.
- `MAX_SPEND_PER_DEAL` / `MAX_SPEND_PER_DAY` — set these in the smallest unit of `MAX_SPEND_COIN` (e.g. if `UCT` has 18 decimals, `100000` is not 100000 UCT — check the coin's decimals via `getAssets()` once running). Start small.
- `TRADE_TARGET_PRICE_USD` — leave blank to disable the trading strategy entirely and only run negotiation/posting.

There's no testnet faucet — top up by self-minting test tokens (see sphere-sdk README, "Test Tokens on Testnet").

```bash
npm run dev
```

Open `http://localhost:8787`.

## Architecture

```
src/agentCore.ts     — Sphere.init(), wallet identity, DM listener
src/strategies.ts    — trading watcher, negotiation watcher, offer poster
                        (all three only ever call queue.propose — never send directly)
src/approvalQueue.ts — human approval gate + hard spending caps
src/server.ts         — Express API + dashboard
public/index.html     — wallet status, pending-deal approve/reject UI, activity log
```

## Important: verify the market/swap API surface

The exact method names on `sphere.market` (`publishIntent`, `subscribe`) and the DM-based negotiation protocol in `strategies.ts` are written against the **described** behavior in the sphere-sdk README (signed intent bulletin board, semantic search, live feed) — the precise method signatures weren't in the README excerpt available when this was built. Before running against live testnet:

1. `npm install`, then check `node_modules/@unicitylabs/sphere-sdk/docs/API.md` (also linked from the repo) for the real `sphere.market` and `sphere.swap` method names.
2. Adjust the calls in `src/strategies.ts` to match — they're isolated in three small functions (`startTradingStrategy`, `startNegotiationStrategy`, `postOwnOffer`) so this should be a quick fix, not a rewrite.
3. Consider using `sphere.swap` (atomic escrow swaps) instead of bare `sphere.payments.send` for the trading/negotiation execute() calls if you want non-custodial settlement instead of a one-sided transfer — the SDK README confirms this module exists with DM-based negotiation built in.

## Deploying for free (Render)

This repo includes `render.yaml` for [Render](https://render.com)'s free web service tier.

1. Push this repo to GitHub.
2. On Render: **New > Blueprint**, point it at the repo — it reads `render.yaml` automatically.
3. Fill in the secret env vars Render will prompt for (`SPHERE_ORACLE_API_KEY`, `WALLET_MNEMONIC`, `AGENT_NAMETAG`, `TRADE_TARGET_PRICE_USD`).
4. Deploy. You'll get a URL like `https://sphere-agent.onrender.com` — that's what goes in the marketplace listing's **App URL** field.

**Important free-tier limitation:** Render's free web services do **not** have a persistent disk — the filesystem resets on every redeploy and the instance sleeps after inactivity. That breaks the "auto-generate mnemonic and save to `wallet-data/`" flow described above, because the saved file would vanish on the next deploy and the agent would come back as a brand-new identity.

**Fix:** generate the mnemonic once locally (`npm run dev` on your machine, copy the printed mnemonic), then set `WALLET_MNEMONIC` as a fixed env var in Render's dashboard before first deploy. The agent will always derive the same identity from it, regardless of redeploys or disk resets. Same logic applies to `AGENT_NAMETAG` — set it once and keep it fixed.

Free-tier services also spin down after ~15 minutes idle and take a few seconds to wake on the next request — fine for testnet development, but expect the embedded iframe in the marketplace to show a brief loading delay on first load after idle.

If you outgrow the free tier (need persistence, no cold starts, or production reliability for mainnet), Render's paid plans add persistent disks, or move to Railway/Fly.io/a VPS as discussed earlier.

## Moving to mainnet

Don't, until you've run this on testnet for a while and you're comfortable with the caps. When you do: the mainnet oracle API key is a real secret (keep it in your deploy environment, never in client code or `.env.example`), and per the SDK README mainnet's gateway was still v1-era as of this writing — `send`/swap calls may fail loudly until Unicity cuts it over to v2. Check the current sphere-sdk README before pointing this at mainnet.
