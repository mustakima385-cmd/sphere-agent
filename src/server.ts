import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActivityLog, ApprovalQueue } from './approvalQueue.js';
import { initAgent } from './agentCore.js';
import { startTradingStrategy, startNegotiationStrategy, postOwnOffer } from './strategies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);

async function main() {
  const log = new ActivityLog();

  const maxPerDeal = BigInt(process.env.MAX_SPEND_PER_DEAL ?? '0');
  const maxPerDay = BigInt(process.env.MAX_SPEND_PER_DAY ?? '0');
  const spendCoin = process.env.MAX_SPEND_COIN ?? 'UCT';

  const queue = new ApprovalQueue(log, {
    maxPerDeal,
    maxPerDayByCoin: { [spendCoin]: maxPerDay },
  });

  log.log(
    'info',
    `Spending caps active: max ${maxPerDeal} per deal, max ${maxPerDay} ${spendCoin} per rolling 24h.`,
  );

  const sphere = await initAgent(log);

  // --- Strategy 1: trading at a target price ---
  if (process.env.TRADE_TARGET_PRICE_USD) {
    startTradingStrategy(sphere, queue, log, {
      coinId: process.env.TRADE_COIN ?? 'UCT',
      targetPriceUsd: parseFloat(process.env.TRADE_TARGET_PRICE_USD),
      side: (process.env.TRADE_SIDE as 'buy' | 'sell') ?? 'buy',
      amountPerTrade: process.env.MAX_SPEND_PER_DEAL ?? '100000',
    });
  } else {
    log.log('warn', 'TRADE_TARGET_PRICE_USD not set — trading strategy disabled.');
  }

  // --- Strategy 2: negotiation on inbound DMs ---
  startNegotiationStrategy(sphere, queue, log, {
    coinId: process.env.TRADE_COIN ?? 'UCT',
    maxPriceUsd: process.env.TRADE_TARGET_PRICE_USD ? parseFloat(process.env.TRADE_TARGET_PRICE_USD) : 1,
    amountWanted: process.env.MAX_SPEND_PER_DEAL ?? '100000',
  });

  // --- Strategy 3: post the agent's own offer ---
  // Customize this call (or add more) for whatever the agent should be
  // offering — left as a manual trigger via POST /api/post-offer below
  // rather than auto-posting on boot, so you control when it goes live.

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/status', async (_req, res) => {
    const assets = await sphere.payments.getAssets().catch(() => []);
    res.json({
      address: sphere.identity?.directAddress,
      nametag: sphere.identity?.nametag,
      network: process.env.SPHERE_NETWORK ?? 'testnet',
      assets,
      caps: { maxPerDeal: maxPerDeal.toString(), maxPerDay: maxPerDay.toString(), coin: spendCoin },
    });
  });

  app.get('/api/log', (_req, res) => {
    res.json(log.list());
  });

  app.get('/api/deals', (_req, res) => {
    res.json(
      queue.list().map((d) => ({
        id: d.id,
        kind: d.kind,
        createdAt: d.createdAt,
        status: d.status,
        summary: d.summary,
        counterparty: d.counterparty,
        coinId: d.coinId,
        amount: d.amount,
        resultDetail: d.resultDetail,
      })),
    );
  });

  app.post('/api/deals/:id/approve', async (req, res) => {
    const deal = await queue.approve(req.params.id);
    if (!deal) return res.status(404).json({ error: 'not found' });
    res.json(deal);
  });

  app.post('/api/deals/:id/reject', (req, res) => {
    const deal = queue.reject(req.params.id);
    if (!deal) return res.status(404).json({ error: 'not found' });
    res.json(deal);
  });

  app.post('/api/post-offer', async (req, res) => {
    const { coinId, amount, askPriceUsd, description } = req.body ?? {};
    if (!coinId || !amount || !askPriceUsd) {
      return res.status(400).json({ error: 'coinId, amount, askPriceUsd required' });
    }
    await postOwnOffer(sphere, queue, log, { coinId, amount, askPriceUsd, description: description ?? '' });
    res.json({ ok: true });
  });

  app.listen(PORT, () => {
    log.log('info', `Dashboard running at http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
