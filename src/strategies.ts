/**
 * NOTE ON THE MARKET / SWAP API SURFACE
 * --------------------------------------
 * The sphere-sdk README confirms `sphere.market` (signed intent bulletin
 * board with semantic search + live feed) and `sphere.swap` (P2P atomic
 * swaps via escrow with DM-based negotiation) exist, but doesn't spell out
 * every method signature in the part of the docs fetched here. Check
 * `docs/API.md` in the sphere-sdk repo for the exact method names/shapes
 * (`sphere.market.publishIntent`, `sphere.market.subscribe`, etc. below are
 * the most plausible names given the README's description — adjust to match
 * once you've installed the package and checked its type definitions).
 * Everything here only ever calls `queue.propose(...)`; nothing sends funds
 * without going through the human-approval gate in approvalQueue.ts.
 */
import type { SphereInstance } from './agentCore.js';
import type { ApprovalQueue } from './approvalQueue.js';
import type { ActivityLog } from './approvalQueue.js';

interface TradingConfig {
  coinId: string;
  targetPriceUsd: number;
  side: 'buy' | 'sell';
  amountPerTrade: string; // smallest-unit string
}

interface MarketIntent {
  id: string;
  authorPubkey: string;
  authorNametag?: string;
  coinId: string;
  amount: string;
  priceUsd?: number;
  description?: string;
}

/** Watches market intents for the configured coin and proposes a trade
 *  whenever a counterparty's posted price crosses the target. */
export function startTradingStrategy(
  sphere: SphereInstance,
  queue: ApprovalQueue,
  log: ActivityLog,
  cfg: TradingConfig,
) {
  const seen = new Set<string>();

  async function evaluate(intent: MarketIntent) {
    if (seen.has(intent.id)) return;
    if (intent.coinId !== cfg.coinId) return;
    if (intent.priceUsd === undefined) return;
    seen.add(intent.id);

    const matches =
      cfg.side === 'buy' ? intent.priceUsd <= cfg.targetPriceUsd : intent.priceUsd >= cfg.targetPriceUsd;
    if (!matches) return;

    queue.propose({
      kind: 'trade',
      coinId: cfg.coinId,
      amount: cfg.amountPerTrade,
      counterparty: intent.authorNametag ?? intent.authorPubkey,
      summary: `${cfg.side.toUpperCase()} ${cfg.amountPerTrade} ${cfg.coinId} @ $${intent.priceUsd} from ${
        intent.authorNametag ?? intent.authorPubkey
      } (target was $${cfg.targetPriceUsd})`,
      execute: async () => {
        const recipient = intent.authorNametag ? `@${intent.authorNametag}` : intent.authorPubkey;
        const result = await sphere.payments.send({
          recipient,
          amount: cfg.amountPerTrade,
          coinId: cfg.coinId,
        });
        return {
          success: !!result.success,
          detail: result.success ? `sent, transfer ${result.transferId ?? ''}` : String((result as any).error),
        };
      },
    });
  }

  try {
    sphere.market?.subscribe?.((intent: MarketIntent) => {
      evaluate(intent).catch((err) => log.log('error', `Trading strategy error: ${err}`));
    });
    log.log('info', `Trading strategy live: ${cfg.side} ${cfg.coinId} at target $${cfg.targetPriceUsd}`);
  } catch (err) {
    log.log('error', `Could not subscribe to market feed: ${err}`);
  }
}

interface NegotiationConfig {
  coinId: string;
  maxPriceUsd: number;
  amountWanted: string;
}

/** Watches the market board for offers matching criteria and opens a DM
 *  negotiation; once the counterparty agrees a price, proposes the deal. */
export function startNegotiationStrategy(
  sphere: SphereInstance,
  queue: ApprovalQueue,
  log: ActivityLog,
  cfg: NegotiationConfig,
) {
  const negotiated = new Set<string>();

  sphere.communications.onDirectMessage(async (msg: any) => {
    // Very simple negotiation protocol: counterparty replies with an
    // agreed price like "ACCEPT 0.42" — adapt to whatever protocol you
    // and counterparties' agents agree on.
    const match = /ACCEPT\s+([\d.]+)/i.exec(msg.content ?? '');
    if (!match) return;
    const agreedPrice = parseFloat(match[1]);
    const key = `${msg.senderPubkey}:${cfg.coinId}`;
    if (negotiated.has(key)) return;
    if (agreedPrice > cfg.maxPriceUsd) return;
    negotiated.add(key);

    queue.propose({
      kind: 'negotiation',
      coinId: cfg.coinId,
      amount: cfg.amountWanted,
      counterparty: msg.senderNametag ?? msg.senderPubkey,
      summary: `Negotiated purchase of ${cfg.amountWanted} ${cfg.coinId} @ $${agreedPrice} with ${
        msg.senderNametag ?? msg.senderPubkey
      }`,
      execute: async () => {
        const recipient = msg.senderNametag ? `@${msg.senderNametag}` : msg.senderPubkey;
        const result = await sphere.payments.send({
          recipient,
          amount: cfg.amountWanted,
          coinId: cfg.coinId,
        });
        return {
          success: !!result.success,
          detail: result.success ? `sent, transfer ${result.transferId ?? ''}` : String((result as any).error),
        };
      },
    });
  });

  log.log('info', `Negotiation strategy live: max $${cfg.maxPriceUsd} for ${cfg.coinId}`);
}

interface PostedOfferConfig {
  coinId: string;
  amount: string;
  askPriceUsd: number;
  description: string;
}

/** Publishes the agent's own offer to the market intents board. Acceptance
 *  by a counterparty (via DM "ACCEPT") still routes through approval. */
export async function postOwnOffer(
  sphere: SphereInstance,
  queue: ApprovalQueue,
  log: ActivityLog,
  cfg: PostedOfferConfig,
) {
  try {
    await sphere.market?.publishIntent?.({
      coinId: cfg.coinId,
      amount: cfg.amount,
      priceUsd: cfg.askPriceUsd,
      description: cfg.description,
    });
    log.log('info', `Posted offer: ${cfg.amount} ${cfg.coinId} @ $${cfg.askPriceUsd} — ${cfg.description}`);
  } catch (err) {
    log.log('error', `Failed to post offer: ${err}`);
  }

  sphere.communications.onDirectMessage(async (msg: any) => {
    const match = /ACCEPT\s+OFFER/i.exec(msg.content ?? '');
    if (!match) return;
    queue.propose({
      kind: 'posted_offer_accept',
      coinId: cfg.coinId,
      amount: cfg.amount,
      counterparty: msg.senderNametag ?? msg.senderPubkey,
      summary: `${msg.senderNametag ?? msg.senderPubkey} accepted posted offer: ${cfg.amount} ${cfg.coinId} @ $${cfg.askPriceUsd}`,
      execute: async () => {
        const recipient = msg.senderNametag ? `@${msg.senderNametag}` : msg.senderPubkey;
        const result = await sphere.payments.send({
          recipient,
          amount: cfg.amount,
          coinId: cfg.coinId,
        });
        return {
          success: !!result.success,
          detail: result.success ? `sent, transfer ${result.transferId ?? ''}` : String((result as any).error),
        };
      },
    });
  });
}
