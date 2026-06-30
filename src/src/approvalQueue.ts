import { randomUUID } from 'node:crypto';
import type { ActivityEvent, ProposedDeal } from './types.js';

const MAX_LOG = 500;

export class ActivityLog {
  private events: ActivityEvent[] = [];

  log(level: ActivityEvent['level'], message: string) {
    const event: ActivityEvent = { id: randomUUID(), timestamp: Date.now(), level, message };
    this.events.unshift(event);
    if (this.events.length > MAX_LOG) this.events.length = MAX_LOG;
    const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[INFO]';
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${message}`);
    return event;
  }

  list(limit = 100): ActivityEvent[] {
    return this.events.slice(0, limit);
  }
}

/**
 * Nothing in this queue ever moves funds on its own. `execute()` only runs
 * after `approve()` is called by a human via the dashboard, and even then
 * it is checked against the hard per-deal and rolling-24h spending caps
 * before the underlying send/swap call is allowed to run.
 */
export class ApprovalQueue {
  private deals = new Map<string, ProposedDeal>();
  private spentLog: { timestamp: number; coinId: string; amount: bigint }[] = [];

  constructor(
    private log: ActivityLog,
    private caps: { maxPerDeal: bigint; maxPerDayByCoin: Record<string, bigint> },
  ) {}

  propose(deal: Omit<ProposedDeal, 'id' | 'createdAt' | 'status'>): ProposedDeal {
    const full: ProposedDeal = {
      ...deal,
      id: randomUUID(),
      createdAt: Date.now(),
      status: 'pending',
    };
    this.deals.set(full.id, full);
    this.log.log('info', `New proposed deal [${full.kind}]: ${full.summary}`);
    return full;
  }

  list(): ProposedDeal[] {
    return [...this.deals.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): ProposedDeal | undefined {
    return this.deals.get(id);
  }

  reject(id: string): ProposedDeal | undefined {
    const deal = this.deals.get(id);
    if (!deal || deal.status !== 'pending') return deal;
    deal.status = 'rejected';
    this.log.log('info', `Deal rejected: ${deal.summary}`);
    return deal;
  }

  private rollingDaySpend(coinId: string): bigint {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.spentLog = this.spentLog.filter((s) => s.timestamp >= cutoff);
    return this.spentLog
      .filter((s) => s.coinId === coinId)
      .reduce((sum, s) => sum + s.amount, 0n);
  }

  /** Approve and execute a deal. Returns the updated deal. */
  async approve(id: string): Promise<ProposedDeal | undefined> {
    const deal = this.deals.get(id);
    if (!deal || deal.status !== 'pending') return deal;

    const amount = BigInt(deal.amount);

    if (amount > this.caps.maxPerDeal) {
      deal.status = 'rejected';
      deal.resultDetail = `Blocked: ${deal.amount} exceeds the per-deal cap of ${this.caps.maxPerDeal}`;
      this.log.log('error', `Deal ${id} blocked by per-deal cap`);
      return deal;
    }

    const dailyCap = this.caps.maxPerDayByCoin[deal.coinId];
    if (dailyCap !== undefined) {
      const already = this.rollingDaySpend(deal.coinId);
      if (already + amount > dailyCap) {
        deal.status = 'rejected';
        deal.resultDetail = `Blocked: would exceed 24h spending cap for ${deal.coinId} (${already} already spent, cap ${dailyCap})`;
        this.log.log('error', `Deal ${id} blocked by daily cap`);
        return deal;
      }
    }

    deal.status = 'approved';
    this.log.log('info', `Deal approved by operator: ${deal.summary}`);

    try {
      const result = await deal.execute();
      deal.status = result.success ? 'executed' : 'failed';
      deal.resultDetail = result.detail;
      if (result.success) {
        this.spentLog.push({ timestamp: Date.now(), coinId: deal.coinId, amount });
        this.log.log('info', `Deal executed: ${deal.summary} — ${result.detail}`);
      } else {
        this.log.log('error', `Deal execution failed: ${result.detail}`);
      }
    } catch (err: any) {
      deal.status = 'failed';
      deal.resultDetail = err?.message ?? String(err);
      this.log.log('error', `Deal execution threw: ${deal.resultDetail}`);
    }

    return deal;
  }
}
