'use client';
import { useRef, useState } from 'react';
import { useActionState } from 'react';
import { createDraftAction, previewAction } from './actions.js';
import { GH_RELEASE } from '../../src/core/validate.js';
import type { AnnouncementType, Audience, Network, Severity } from '../../src/core/types.js';
import type { PreviewSet } from '../../src/core/preview.js';

const NETWORKS: Network[] = ['mainnet', 'testnet'];
const TYPES: AnnouncementType[] = ['upgrade', 'governance', 'info'];
const SEVERITIES: Severity[] = ['critical', 'recommended', 'info'];
const AUDIENCES: Audience[] = ['operators', 'ecosystem'];

type Result = { id?: string; error?: string };

async function action(_prev: Result | undefined, formData: FormData): Promise<Result> {
  return createDraftAction(formData);
}

const box = (name: string, value: string, checked: boolean) => (
  <label className="check" key={value}>
    <input type="checkbox" name={name} value={value} defaultChecked={checked} /> {value}
  </label>
);

type ActionRow = { key: number; deadline: string; appliesTo: string };
type LinkRow = { key: number; url: string };

type ToolbarOp =
  | { label: string; title: string; wrap: [string, string] }
  | { label: string; title: string; prefix: string };

const TOOLBAR: ToolbarOp[] = [
  { label: 'B', title: 'Bold', wrap: ['**', '**'] },
  { label: 'I', title: 'Italic', wrap: ['*', '*'] },
  { label: '</>', title: 'Code', wrap: ['`', '`'] },
  { label: 'Link', title: 'Link', wrap: ['[', '](url)'] },
  { label: '•', title: 'Bullet list', prefix: '- ' },
  { label: 'H', title: 'Heading', prefix: '## ' },
];

type PreviewChannel = 'discord' | 'telegram' | 'signal' | 'email' | 'webhook';
const PREVIEW_CHANNELS: PreviewChannel[] = ['discord', 'telegram', 'signal', 'email', 'webhook'];

type PreviewResult = { preview?: PreviewSet; error?: string };

export default function ComposeForm() {
  const [result, formAction, pending] = useActionState<Result | undefined, FormData>(action, undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [type, setType] = useState<AnnouncementType>('upgrade');
  const [actionRows, setActionRows] = useState<ActionRow[]>([]);
  const [linkRows, setLinkRows] = useState<LinkRow[]>([{ key: 0, url: '' }]);
  const nextActionKey = useRef(0);
  const nextLinkKey = useRef(1);
  const [previewTab, setPreviewTab] = useState<PreviewChannel>('discord');
  const [previewResult, setPreviewResult] = useState<PreviewResult | undefined>(undefined);
  const [previewPending, setPreviewPending] = useState(false);

  async function refreshPreview() {
    const el = formRef.current;
    if (!el) return;
    setPreviewPending(true);
    try {
      const formData = new FormData(el);
      const res = await previewAction(formData);
      setPreviewResult(res);
    } finally {
      setPreviewPending(false);
    }
  }

  function applyToolbarOp(op: ToolbarOp) {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = el.value.slice(start, end);

    if ('wrap' in op) {
      const [before, after] = op.wrap;
      el.setRangeText(`${before}${selected}${after}`, start, end, 'select');
      const cursor = start + before.length;
      el.setSelectionRange(cursor, cursor + selected.length);
    } else {
      el.setRangeText(op.prefix, start, start, 'end');
    }
    el.focus();
  }

  const showGithubWarning = type === 'upgrade' && !linkRows.some(row => GH_RELEASE.test(row.url));

  return (
    <div className="card compose-grid">
      <div>
        <h2>New announcement</h2>
        {result?.error && <div className="notice"><p>Error: {result.error}</p></div>}

        <form action={formAction} ref={formRef}>
          <label htmlFor="title">Title</label>
          <input id="title" type="text" name="title" placeholder="v5.1.0 release" required />

          <fieldset>
            <legend>Type</legend>
            {TYPES.map(v => (
              <label className="check" key={v}>
                <input
                  type="radio"
                  name="type"
                  value={v}
                  defaultChecked={v === type}
                  onChange={() => setType(v)}
                />{' '}
                {v}
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend>Severity</legend>
            {SEVERITIES.map(v => (
              <label className="check" key={v}>
                <input type="radio" name="severity" value={v} defaultChecked={v === 'recommended'} /> {v}
              </label>
            ))}
          </fieldset>

          <fieldset><legend>Networks</legend>{NETWORKS.map(v => box('networks', v, true))}</fieldset>
          <fieldset><legend>Audience</legend>{AUDIENCES.map(v => box('audiences', v, v === 'operators'))}</fieldset>

          <label htmlFor="bodyMd">Body (Markdown)</label>
          <div className="toolbar">
            {TOOLBAR.map(op => (
              <button
                type="button"
                key={op.title}
                title={op.title}
                onClick={() => applyToolbarOp(op)}
              >
                {op.label}
              </button>
            ))}
          </div>
          <textarea
            id="bodyMd"
            name="bodyMd"
            ref={textareaRef}
            rows={14}
            placeholder="What's changing, and why it matters."
            required
          />

          {showGithubWarning && (
            <div className="notice">
              <p>Upgrade announcements should include the official GitHub release link.</p>
            </div>
          )}

          <fieldset>
            <legend>Actions required</legend>
            {actionRows.map((row, i) => (
              <div className="row-repeat" key={row.key}>
                <input type="text" name={`action.${i}`} placeholder="Action (e.g. Update your node)" />
                <input type="datetime-local" name={`deadline.${i}`} />
                <input type="text" name={`appliesTo.${i}`} placeholder="Applies to (comma-separated roles)" />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setActionRows(rows => rows.filter(r => r.key !== row.key))}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() => setActionRows(rows => [...rows, { key: nextActionKey.current++, deadline: '', appliesTo: '' }])}
            >
              Add action
            </button>
          </fieldset>

          <fieldset>
            <legend>Links</legend>
            {linkRows.map((row, i) => (
              <div className="row-repeat" key={row.key}>
                <input
                  type="text"
                  name={`linkLabel.${i}`}
                  placeholder="Label (e.g. GitHub release)"
                />
                <input
                  type="url"
                  name={`linkUrl.${i}`}
                  placeholder="https://…"
                  value={row.url}
                  onChange={e => {
                    const url = e.target.value;
                    setLinkRows(rows => rows.map(r => (r.key === row.key ? { ...r, url } : r)));
                  }}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setLinkRows(rows => rows.filter(r => r.key !== row.key))}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() => setLinkRows(rows => [...rows, { key: nextLinkKey.current++, url: '' }])}
            >
              Add link
            </button>
          </fieldset>

          <label htmlFor="expiresAt">Expires (optional)</label>
          <input id="expiresAt" type="datetime-local" name="expiresAt" />

          <div>
            <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save draft'}</button>
          </div>
        </form>
      </div>

      <div className="compose-preview">
        <h2>Preview</h2>
        <div>
          <button type="button" onClick={refreshPreview} disabled={previewPending}>
            {previewPending ? 'Refreshing…' : 'Refresh preview'}
          </button>
        </div>

        {previewResult?.error && (
          <div className="notice"><p>Error: {previewResult.error}</p></div>
        )}

        <div className="preview-tabs" role="tablist" style={{ marginTop: 14 }}>
          {PREVIEW_CHANNELS.map(ch => (
            <button
              type="button"
              key={ch}
              role="tab"
              aria-selected={previewTab === ch}
              onClick={() => setPreviewTab(ch)}
            >
              {ch}
            </button>
          ))}
        </div>

        <div className="preview-panel" role="tabpanel">
          {!previewResult?.preview ? (
            <p className="preview-empty">Click &quot;Refresh preview&quot; to see how this announcement will render on each channel.</p>
          ) : (
            <PreviewPane channel={previewTab} preview={previewResult.preview} />
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewPane({ channel, preview }: { channel: PreviewChannel; preview: PreviewSet }) {
  switch (channel) {
    case 'discord':
      if (preview.discord.length === 0) {
        return <p className="preview-empty">No Discord channel matches this announcement&apos;s network and type.</p>;
      }
      return (
        <>
          {preview.discord.map(d => (
            <div className="preview-discord-entry" key={d.target}>
              <p className="preview-discord-target">{d.target}</p>
              <div>{d.content}</div>
            </div>
          ))}
        </>
      );
    case 'telegram':
      return <div>{preview.telegram}</div>;
    case 'signal':
      return <div>{preview.signal}</div>;
    case 'email':
      return (
        <>
          <p className="preview-discord-target">Subject: {preview.email.subject}</p>
          <div>{preview.email.text}</div>
        </>
      );
    case 'webhook':
      return <div>{preview.webhook}</div>;
  }
}
