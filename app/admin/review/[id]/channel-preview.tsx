'use client';

import { useState } from 'react';
import { PreviewPane, type PreviewChannel, type PreviewMode } from '../../preview-pane.js';
import type { PreviewSet } from '../../../../src/core/preview.js';

const CHANNEL_ORDER: PreviewChannel[] = ['discord', 'telegram', 'signal', 'email', 'webhook'];

const CHANNEL_LABEL: Record<PreviewChannel, string> = {
  discord: 'Discord',
  telegram: 'Telegram',
  signal: 'Signal',
  email: 'Email',
  webhook: 'Webhook',
};

/**
 * The channels this announcement actually has a payload for. Mirrors the
 * undefined/empty conventions PreviewSet already uses: a broadcast channel is
 * absent (or, for discord, an empty array) when no channel_settings row
 * matches this announcement's network and type, which is exactly when
 * countFanoutTargets would not deliver to it either. Exported so it can be
 * tested without a React renderer.
 */
export function availableChannels(preview: PreviewSet): PreviewChannel[] {
  return CHANNEL_ORDER.filter(c => {
    if (c === 'discord') return (preview.discord?.length ?? 0) > 0;
    return preview[c] !== undefined;
  });
}

export default function ChannelPreview({ preview }: { preview: PreviewSet }) {
  const channels = availableChannels(preview);
  const [channel, setChannel] = useState<PreviewChannel>(channels[0] ?? 'webhook');
  const [mode, setMode] = useState<PreviewMode>('rendered');

  if (channels.length === 0) {
    return <p className="muted">No channel will receive this announcement.</p>;
  }

  return (
    <div>
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
        This is what each channel receives. The publication time is set when publishing
        happens, so the webhook payload shows <code>published_at: null</code> here.
      </p>
    </div>
  );
}
