'use client';

import type { PreviewSet } from '../../src/core/preview.js';
import {
  parseMarkdownBlocks, parseTelegramHtml, parseMentions,
  type Block, type Inline,
} from './preview-render.js';

export type PreviewChannel = 'discord' | 'telegram' | 'signal' | 'email' | 'webhook';
export type PreviewMode = 'rendered' | 'raw';

function Spans({ spans }: { spans: Inline[] }) {
  return (
    <>
      {spans.map((s, i) => {
        if (s.text === '') return null;
        if (s.kind === 'bold') return <strong key={i}>{s.text}</strong>;
        if (s.kind === 'code') return <code key={i} className="pv-code">{s.text}</code>;
        if (s.kind === 'link') return <a key={i} href={s.href} className="pv-link">{s.text}</a>;
        return <span key={i}>{s.text}</span>;
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'heading') {
          return b.level === 2
            ? <h3 key={i} className="pv-h2">{b.text}</h3>
            : <h4 key={i} className="pv-h3">{b.text}</h4>;
        }
        if (b.kind === 'tag') return <p key={i} className="pv-tagline">{b.text}</p>;
        if (b.kind === 'bullet') {
          return <p key={i} className="pv-bullet"><span className="pv-dot">•</span><Spans spans={b.spans} /></p>;
        }
        return <p key={i} className="pv-para"><Spans spans={b.spans} /></p>;
      })}
    </>
  );
}

/** Mentions drawn as Discord draws them — as pills. The raw view shows the literal bytes. */
function MentionPrefix({ prefix }: { prefix: string }) {
  return (
    <p className="pv-prefix">
      {parseMentions(prefix).map((s, i) =>
        s.kind === 'bold'
          ? <span key={i} className="pv-mention">{s.text}</span>
          : <span key={i}>{s.text}</span>,
      )}
    </p>
  );
}

export function PreviewPane(
  { channel, preview, mode }: { channel: PreviewChannel; preview: PreviewSet; mode: PreviewMode },
) {
  const raw = mode === 'raw';

  switch (channel) {
    case 'discord': {
      if (!preview.discord || preview.discord.length === 0) {
        return <p className="preview-empty">No Discord channel matches this announcement&apos;s network and type.</p>;
      }
      return (
        <>
          {raw && (
            <p className="pv-rawnote">
              Exact bytes posted to Discord, prefix included.
            </p>
          )}
          {preview.discord.map(d => (
            <div className="preview-discord-entry" key={d.target}>
              <p className="preview-discord-target">{d.target}</p>
              {raw ? (
                <div className="pv-raw">{d.content}</div>
              ) : (
                <div className="pv-surface pv-discord">
                  {d.prefix && <MentionPrefix prefix={d.prefix} />}
                  <Blocks blocks={parseMarkdownBlocks(
                    d.prefix ? d.content.slice(d.prefix.length + 1) : d.content,
                  )} />
                </div>
              )}
            </div>
          ))}
        </>
      );
    }
    case 'telegram':
      if (!preview.telegram) {
        return <p className="preview-empty">No Telegram channel matches this announcement&apos;s network and type.</p>;
      }
      return raw
        ? <div className="pv-raw">{preview.telegram}</div>
        : (
          <div className="pv-surface pv-telegram">
            <Blocks blocks={parseTelegramHtml(preview.telegram)} />
          </div>
        );
    case 'signal':
      if (!preview.signal) {
        return <p className="preview-empty">No Signal channel matches this announcement&apos;s network and type.</p>;
      }
      // Signal is plain text on the wire, so the rendered view differs only in
      // its surface styling — the text itself is already what a reader sees.
      return raw
        ? <div className="pv-raw">{preview.signal}</div>
        : <div className="pv-surface pv-signal"><div className="pv-plain">{preview.signal}</div></div>;
    case 'email': {
      if (!preview.email) return null;
      return (
        <>
          <p className="preview-discord-target">Subject: {preview.email.subject}</p>
          {raw ? (
            <div className="pv-raw">{preview.email.text}</div>
          ) : (
            <div className="pv-surface pv-email">
              {/*
               * dangerouslySetInnerHTML is scoped and deliberate here: this string
               * comes from renderEmail, which escapes every author-supplied value
               * through escapeHtml before composing the template — it is the same
               * HTML already sent to real inboxes, not attacker-controlled markup.
               * Keep the escaping in render.ts intact; if a future change lets
               * unescaped author text into that string, this line becomes an XSS
               * sink. Do not extend this technique to any other channel.
               */}
              <div
                className="pv-emailhtml"
                dangerouslySetInnerHTML={{ __html: preview.email.html }}
              />
            </div>
          )}
        </>
      );
    }
    case 'webhook':
      // Webhook consumers receive JSON, so the payload IS the readable form.
      return <div className="pv-raw">{preview.webhook}</div>;
  }
}
