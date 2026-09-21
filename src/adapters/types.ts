import type { Announcement, DeliveryKind } from '../core/types.js';

/** Outcome of a post-delivery publish step, if the channel has one. */
export interface DeliveryResult { publishNote?: string }

export interface ChannelAdapter {
  channel: string;
  /** Deliver one announcement to one target. Throw on failure — the worker handles retry. */
  deliver(a: Announcement, target: string, kind: DeliveryKind): Promise<void | DeliveryResult>;
}
