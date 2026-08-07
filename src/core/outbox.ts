import type { TransactionSql } from 'postgres';
import type { Announcement, AnnouncementType, DeliveryKind, DeliveryTarget, Network } from './types.js';
import { matchesSubscription, rowToSub } from './subscriptions.js';

export interface ChannelSetting {
  key: string; channel: 'discord' | 'telegram' | 'signal';
  networks: Network[]; types: AnnouncementType[]; config: Record<string, unknown>;
}

export function rowToSetting(r: Record<string, unknown>): ChannelSetting {
  const cfg = r.config as Record<string, unknown>;
  return {
    key: r.key as string, channel: r.channel as ChannelSetting['channel'],
    networks: (cfg.networks as Network[]) ?? ['mainnet', 'testnet'],
    types: (cfg.types as AnnouncementType[]) ?? ['upgrade', 'governance', 'info'],
    config: cfg,
  };
}

const intersects = (a: readonly string[], b: readonly string[]) => a.some(v => b.includes(v));

export function broadcastTargetsFor(
  a: Pick<Announcement, 'networks' | 'type'>, settings: ChannelSetting[],
): DeliveryTarget[] {
  return settings
    .filter(cs => intersects(cs.networks, a.networks) && cs.types.includes(a.type))
    .map(cs => ({ channel: cs.channel, target: cs.key }));
}

export async function enqueueDeliveries(tx: TransactionSql, a: Announcement, kind: DeliveryKind): Promise<number> {
  const settings = (await tx`select * from channel_settings`).map(rowToSetting);
  const targets: DeliveryTarget[] = broadcastTargetsFor(a, settings);

  const subs = await tx`select * from subscriptions where verified = true`;
  for (const row of subs) {
    const s = rowToSub(row);
    if (matchesSubscription(a, s)) targets.push({ channel: s.channel, target: s.id });
  }

  let inserted = 0;
  for (const t of targets) {
    const res = await tx`insert into delivery_ledger (announcement_id, revision, kind, channel, target)
      values (${a.id}, ${a.revision}, ${kind}, ${t.channel}, ${t.target})
      on conflict do nothing`;
    inserted += res.count;
  }
  return inserted;
}
