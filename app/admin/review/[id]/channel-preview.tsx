'use client';

import { useState } from 'react';
import { PreviewPane, CHANNEL_ORDER, type PreviewChannel, type PreviewMode } from '../../preview-pane.js';
import { parseMentions } from '../../preview-render.js';
import type { PreviewSet } from '../../../../src/core/preview.js';

const CHANNEL_LABEL: Record<PreviewChannel, string> = {
  discord: 'Discord',
  telegram: 'Telegram',
  signal: 'Signal',
  email: 'Email',
  webhook: 'Webhook',
};

/**
 * The channels this announcement actually has a payload for. Mirrors the
 * undefined/empty conventions PreviewSet already uses: a channel is absent
 * (or, for discord, an empty array) when no channel_settings row matches this
 * announcement's network and type, OR when ENABLED_CHANNELS has it turned
 * off — src/core/preview.ts applies the same isChannelEnabled gate
 * countFanoutTargets does, so this list is exactly what countFanoutTargets
 * would deliver to. Exported so it can be tested without a React renderer.
 */
export function availableChannels(preview: PreviewSet): PreviewChannel[] {
  return CHANNEL_ORDER.filter(c => {
    if (c === 'discord') return (preview.discord?.length ?? 0) > 0;
    return preview[c] !== undefined;
  });
}

/**
 * Every distinct mention across all Discord destinations, drawn from the same
 * parseMentions the preview pills use — so this summary cannot name a role the
 * payload does not mention, or miss one it does. Order is first-seen, which
 * follows the configured prefix order.
 */
export function mentionedRoleNames(preview: PreviewSet): string[] {
  const names: string[] = [];
  for (const d of preview.discord ?? []) {
    if (!d.prefix) continue;
    for (const span of parseMentions(d.prefix, d.roles)) {
      if (span.kind !== 'bold') continue;
      if (!names.includes(span.text)) names.push(span.text);
    }
  }
  return names;
}

export default function ChannelPreview({ preview, published = false }: { preview: PreviewSet; published?: boolean }) {
  const channels = availableChannels(preview);
  const [channel, setChannel] = useState<PreviewChannel>(channels[0] ?? 'webhook');
  const [mode, setMode] = useState<PreviewMode>('rendered');
  const mentions = mentionedRoleNames(preview);

  if (channels.length === 0) {
    return <p className="muted">No channel will receive this announcement.</p>;
  }

  return (
    <div>
      {mentions.length > 0 && (
        <p className="mention-summary" data-state="mention-summary">
          <strong>Discord will notify:</strong>{' '}
          {mentions.map((m, i) => (
            <span key={i} className="pv-mention">{m}</span>
          ))}
          {' '}
          <span className="muted">Open the Discord tab in Raw to see the exact bytes.</span>
        </p>
      )}

      {/* The stylesheet keys off aria-selected / aria-pressed on bare buttons
          inside .preview-tabs and .preview-mode (app/globals.css). Do not add
          an is-active class — there is no rule for one. */}
      <div className="preview-tabs" role="tablist">
        {channels.map(c => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={channel === c}
            onClick={() => setChannel(c)}
          >
            {CHANNEL_LABEL[c]}
          </button>
        ))}
      </div>

      <div className="preview-mode" role="group" aria-label="Preview mode">
        {(['rendered', 'raw'] as PreviewMode[]).map(m => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            data-state={mode === m ? 'active' : 'inactive'}
            onClick={() => setMode(m)}
          >
            {m === 'rendered' ? 'Rendered' : 'Raw payload'}
          </button>
        ))}
      </div>

      {preview.warnings && preview.warnings.length > 0 && (
        <div className="notice">
          <ul>{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      <div className="preview-panel" role="tabpanel" data-state="review-preview">
        <PreviewPane channel={channel} preview={preview} mode={mode} />
      </div>

      <p className="muted">
        This is what each channel receives.{' '}
        {!published && (
          <>
            The publication time is set when publishing happens, so the webhook payload
            shows <code>published_at: null</code> here.
          </>
        )}
      </p>
    </div>
  );
}
