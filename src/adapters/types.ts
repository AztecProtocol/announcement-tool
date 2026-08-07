import type { Announcement, DeliveryKind } from '../core/types.js';

export interface ChannelAdapter {
  channel: string;
  /** Deliver one announcement to one target. Throw on failure — the worker handles retry. */
  deliver(a: Announcement, target: string, kind: DeliveryKind): Promise<void>;
}
