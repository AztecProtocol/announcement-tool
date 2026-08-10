import type { Sql } from 'postgres';
import type { ChannelAdapter } from './types.js';
import type { EmailSender } from './esp.js';
import type { Announcement, DeliveryKind } from '../core/types.js';
import { renderEmail } from '../core/render.js';
import { getSubscription } from '../core/subscriptions.js';

export function makeEmailAdapter(
  sql: Sql, sender: EmailSender, opts: { baseUrl?: string } = {},
): ChannelAdapter {
  return {
    channel: 'email',
    async deliver(a: Announcement, target: string, kind: DeliveryKind): Promise<void> {
      const sub = await getSubscription(sql, target);
      if (!sub) throw new Error(`email subscription not found: ${target}`);
      if (!sub.verified) throw new Error(`email subscription is unverified: ${target}`);

      const base = (opts.baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'https://announce.aztec.foundation')
        .replace(/\/+$/, '');
      const unsubscribeUrl = `${base}/u/${sub.unsubscribeToken}`;

      const { subject, text } = renderEmail(a, kind);
      await sender.send({
        to: sub.endpoint,
        subject,
        text: text.replaceAll('{{UNSUBSCRIBE}}', unsubscribeUrl),
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
    },
  };
}
