import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';

export const newAnnouncementId = () => `ann_${ulid()}`;
export const newSubscriptionId = () => `sub_${ulid()}`;
export const newSecret = () => `whsec_${randomBytes(24).toString('hex')}`;
export const newToken = () => randomBytes(16).toString('hex');

export function makeSlug(date: Date, type: string, title: string): string {
  const ym = date.toISOString().slice(0, 7);
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 7).join('-');
  return `${ym}-${type}-${words}`.slice(0, 80);
}
