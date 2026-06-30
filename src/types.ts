export type DealKind = 'trade' | 'negotiation' | 'posted_offer_accept';

export type DealStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired';

export interface ProposedDeal {
  id: string;
  kind: DealKind;
  createdAt: number;
  status: DealStatus;
  // Human-readable summary shown on the dashboard
  summary: string;
  // Counterparty nametag or pubkey, if known
  counterparty?: string;
  coinId: string;
  amount: string; // smallest-unit string, never a float
  // Action to run once approved — kept generic so trading / negotiation /
  // posted-offer-acceptance can all enqueue the same shape of deal.
  execute: () => Promise<{ success: boolean; detail: string }>;
  resultDetail?: string;
}

export interface ActivityEvent {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}
