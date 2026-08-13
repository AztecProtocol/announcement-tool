import type { Sql } from 'postgres';
import type { AnnouncementType, Severity, Network, Audience } from './types.js';
import { newSubscriptionId, newSecret, newToken } from './ids.js';

export interface SubscriptionFilters {
  networks: Network[]; types: AnnouncementType[]; severities: Severity[]; audiences: Audience[];
}
export interface Subscription {
  id: string; channel: 'email' | 'webhook'; endpoint: string; verified: boolean;
  secret?: string; filters: SubscriptionFilters; unsubscribeToken: string; verifyToken: string;
}

const DEFAULTS: SubscriptionFilters = {
  networks: ['mainnet', 'testnet'],
  types: ['upgrade', 'governance', 'info'],
  severities: ['critical', 'recommended', 'info'],
  audiences: ['operators'],
};

export function rowToSub(r: Record<string, unknown>): Subscription {
  return {
    id: r.id as string, channel: r.channel as 'email' | 'webhook', endpoint: r.endpoint as string,
    verified: r.verified as boolean, secret: (r.secret as string | null) ?? undefined,
    filters: {
      networks: r.filter_networks as Network[], types: r.filter_types as AnnouncementType[],
      severities: r.filter_severities as Severity[], audiences: r.filter_audiences as Audience[],
    },
    unsubscribeToken: r.unsubscribe_token as string,
    verifyToken: r.verify_token as string,
  };
}

export async function createSubscription(
  sql: Sql,
  input: { channel: 'email' | 'webhook'; endpoint: string; filters?: Partial<SubscriptionFilters> },
): Promise<Subscription> {
  for (const [k, v] of Object.entries(input.filters ?? {})) {
    if (Array.isArray(v) && v.length === 0) throw new Error(`filter ${k} must not be empty`);
  }
  const f = { ...DEFAULTS, ...input.filters };
  const id = newSubscriptionId();
  const secret = input.channel === 'webhook' ? newSecret() : null;
  const unsubscribeToken = newToken();
  const verifyToken = newToken();
  const [row] = await sql`insert into subscriptions
    (id, channel, endpoint, secret, filter_networks, filter_types, filter_severities, filter_audiences, unsubscribe_token, verify_token)
    values (${id}, ${input.channel}, ${input.endpoint}, ${secret},
            ${f.networks}, ${f.types}, ${f.severities}, ${f.audiences}, ${unsubscribeToken}, ${verifyToken})
    returning *`;
  return rowToSub(row);
}

export async function updateSubscriptionFilters(
  sql: Sql, id: string, f: Partial<SubscriptionFilters>,
): Promise<void> {
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) && v.length === 0) throw new Error(`filter ${k} must not be empty`);
  }
  // One statement: coalesce leaves unmentioned columns untouched, so a partial
  // update can never half-apply the way three sequential statements could.
  await sql`update subscriptions set
    filter_networks   = coalesce(${f.networks ?? null}::text[], filter_networks),
    filter_types      = coalesce(${f.types ?? null}::text[], filter_types),
    filter_severities = coalesce(${f.severities ?? null}::text[], filter_severities),
    filter_audiences  = coalesce(${f.audiences ?? null}::text[], filter_audiences)
    where id = ${id}`;
}

export async function verifySubscription(sql: Sql, id: string): Promise<void> {
  await sql`update subscriptions set verified = true where id = ${id}`;
}

export async function getSubscription(sql: Sql, id: string): Promise<Subscription | undefined> {
  const rows = await sql`select * from subscriptions where id = ${id}`;
  return rows[0] ? rowToSub(rows[0]) : undefined;
}

export async function getSubscriptionByVerifyToken(sql: Sql, token: string): Promise<Subscription | undefined> {
  const rows = await sql`select * from subscriptions where verify_token = ${token}`;
  return rows[0] ? rowToSub(rows[0]) : undefined;
}

export async function getSubscriptionByUnsubscribeToken(sql: Sql, token: string): Promise<Subscription | undefined> {
  const rows = await sql`select * from subscriptions where unsubscribe_token = ${token}`;
  return rows[0] ? rowToSub(rows[0]) : undefined;
}

const intersects = (a: readonly string[], b: readonly string[]) => a.some(v => b.includes(v));

export function matchesSubscription(
  a: { type: AnnouncementType; severity: Severity; networks: Network[]; audiences: Audience[] },
  s: Subscription,
): boolean {
  return intersects(a.networks, s.filters.networks)
    && s.filters.types.includes(a.type)
    && s.filters.severities.includes(a.severity)
    && intersects(a.audiences, s.filters.audiences);
}
