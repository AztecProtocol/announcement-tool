'use client';
import { useEffect, useRef, useState } from 'react';
import { useActionState } from 'react';
// Deep import, not `next/navigation` — see tsconfig.json's `paths` comment.
// The `paths` mapping there fixes `tsc`/NodeNext resolution for the public
// specifier but Turbopack then resolves the RUNTIME import through the same
// mapping to the .d.ts (no exports), giving `(void 0) is not a function` for
// useRouter specifically — the same failure mode already documented for
// `next/headers`, just not previously hit for `next/navigation` because no
// admin client component had called useRouter until this one.
import { useRouter } from 'next/dist/client/components/navigation.js';
import { createDraftAction, saveRevisionAction, previewAction, saveTemplateAction } from './actions.js';
import { GH_RELEASE } from '../../src/core/validate.js';
import type { AnnouncementInput, AnnouncementType, Audience, DiscordRole, Network, Severity } from '../../src/core/types.js';
import type { PreviewSet } from '../../src/core/preview.js';
import { PreviewPane, CHANNEL_ORDER, type PreviewChannel, type PreviewMode } from './preview-pane.js';
import { normalizeSlug, slugError } from '../../src/core/slug.js';
import { makeSlug } from '../../src/core/ids.js';
import { isoToUtcInput } from '../../src/core/datetime.js';
import { parseRoles } from '../../src/core/roles.js';
import { BUILTIN_ROLES } from '../../src/core/discord-mentions.js';
import { ActionRowFields, type ActionRow } from './action-row.js';

const NETWORKS: Network[] = ['mainnet', 'testnet'];
const TYPES: AnnouncementType[] = ['upgrade', 'governance', 'info'];
const SEVERITIES: Severity[] = ['critical', 'recommended', 'info'];
const AUDIENCES: Audience[] = ['operators', 'ecosystem'];

type Result = { id?: string; error?: string };

const box = (name: string, value: string, checked: boolean) => (
  <label className="check" key={value}>
    <input type="checkbox" name={name} value={value} defaultChecked={checked} /> {value}
  </label>
);

type LinkRow = { key: number; label: string; url: string };

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

type PreviewResult = { preview?: PreviewSet; error?: string };

export type ComposeFormProps = {
  templates?: { id: string; name: string }[];
  recentAnnouncements?: { id: string; title: string; slug: string }[];
  discordRoles?: DiscordRole[];
  prefill?: AnnouncementInput;
  /** Set when continuing an existing draft (`?from=edit:<id>`) rather than creating a new one. */
  editingId?: string;
  /**
   * Channels this deployment fans out to. Passed from the server because this
   * is a client component: ENABLED_CHANNELS is server-only, and a NEXT_PUBLIC_
   * twin would be a second source of truth that can disagree with the gate in
   * src/core/outbox.ts. Defaults to all five so existing callers and tests keep
   * working.
   */
  enabledChannels?: PreviewChannel[];
};

export default function ComposeForm({ templates = [], recentAnnouncements = [], discordRoles = [], prefill, editingId, enabledChannels }: ComposeFormProps) {
  // Sorted to the same fixed order the review screen uses (CHANNEL_ORDER),
  // not the order the operator happened to type into ENABLED_CHANNELS — so
  // ENABLED_CHANNELS=webhook,discord does not silently open compose on the
  // raw-JSON Webhook tab while review always opens on Discord.
  const previewChannels = CHANNEL_ORDER.filter(c => (enabledChannels ?? CHANNEL_ORDER).includes(c));
  const router = useRouter();
  const action = async (_prev: Result | undefined, formData: FormData): Promise<Result> =>
    editingId ? saveRevisionAction(editingId, formData) : createDraftAction(formData);
  const [result, formAction, pending] = useActionState<Result | undefined, FormData>(action, undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [type, setType] = useState<AnnouncementType>(prefill?.type ?? 'upgrade');
  const [severity, setSeverity] = useState<Severity>(prefill?.severity ?? 'recommended');
  const [title, setTitle] = useState(prefill?.title ?? '');
  // A prefilled draft from a template or a past announcement must never
  // inherit the source's slug — slugs are unique, so starting blank and
  // letting the effect below derive a fresh one from the title is correct
  // even when prefill.slug is present on the source AnnouncementInput.
  // Edit mode is the one exception: it continues the *same* announcement,
  // whose slug is fixed at revision 1 by a unique index, so it starts
  // pre-set to prefill.slug and the effect below must never touch it.
  const [slug, setSlug] = useState(editingId ? (prefill?.slug ?? '') : '');
  const [slugTouched, setSlugTouched] = useState(false);
  const [actionRows, setActionRows] = useState<ActionRow[]>(
    (prefill?.actionsRequired ?? []).map((ar, i) => ({
      key: i,
      action: ar.action,
      deadline: isoToUtcInput(ar.deadline),
      appliesTo: ar.applies_to.join(', '),
    })),
  );
  const [linkRows, setLinkRows] = useState<LinkRow[]>(
    (prefill?.links ?? []).length > 0
      ? prefill!.links.map((l, i) => ({ key: i, label: l.label, url: l.url }))
      : [{ key: 0, label: '', url: '' }],
  );
  const nextActionKey = useRef(actionRows.length);
  const nextLinkKey = useRef(linkRows.length);
  // Built-ins (@everyone / @here) default OFF even for critical: notifying an
  // entire server must be an affirmative click, since selecting a built-in is
  // the one selection this tool cannot narrow with allowed_mentions. Named
  // roles default ON for critical, same as before.
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>(
    prefill?.mentionRoleIds ?? (severity === 'critical' ? discordRoles.map(r => r.id) : []),
  );
  const [rolesTouched, setRolesTouched] = useState(false);
  const [previewTab, setPreviewTab] = useState<PreviewChannel>(previewChannels[0] ?? 'discord');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('rendered');
  const [previewResult, setPreviewResult] = useState<PreviewResult | undefined>(undefined);
  const [previewPending, setPreviewPending] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [saveTemplateResult, setSaveTemplateResult] = useState<{ ok?: true; error?: string } | undefined>(undefined);
  const [saveTemplatePending, setSaveTemplatePending] = useState(false);

  // Track the title until the author edits the slug themselves; from then on the
  // typed value stands, because a slug they chose should not silently change.
  // In edit mode the slug field is read-only (see below) and must never be
  // rewritten as the title changes, so this effect is skipped entirely.
  useEffect(() => {
    if (editingId) return;
    if (slugTouched) return;
    setSlug(title.trim() ? makeSlug(new Date(), type, title) : '');
  }, [title, type, slugTouched, editingId]);

  // Mirrors slugTouched: the role selection tracks severity — named roles for
  // critical, none otherwise, built-ins never pre-selected — until the author
  // overrides it themselves, after which their choice stands. In edit mode
  // the initial selection is seeded from the announcement's own
  // mentionRoleIds (see useState above) and must not be overwritten by
  // severity on mount — a critical draft rejected specifically over its
  // mention list must not have every named role silently re-armed, and a
  // non-critical draft's chosen roles must not be silently cleared. So this
  // effect is skipped entirely in edit mode, matching the slug effect above.
  useEffect(() => {
    if (editingId) return;
    if (!rolesTouched) setSelectedRoleIds(severity === 'critical' ? discordRoles.map(r => r.id) : []);
    // discordRoles is derived fresh from props each render; only severity,
    // the touched flag, and editingId should re-run this, matching the
    // slugTouched effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [severity, rolesTouched, editingId]);

  function goto(from: string) {
    router.push(from ? `/admin?from=${encodeURIComponent(from)}` : '/admin');
  }

  async function handleSaveTemplate() {
    const el = formRef.current;
    if (!el || !templateName.trim()) return;
    setSaveTemplatePending(true);
    try {
      const formData = new FormData(el);
      formData.set('templateName', templateName.trim());
      const res = await saveTemplateAction(formData);
      setSaveTemplateResult(res.error ? { error: res.error } : { ok: true });
    } finally {
      setSaveTemplatePending(false);
    }
  }

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

  function toggleMentionRole(id: string, checked: boolean) {
    setSelectedRoleIds(ids => (checked ? [...ids, id] : ids.filter(x => x !== id)));
  }

  function toggleRole(index: number, role: string) {
    setActionRows(rows => rows.map((r, idx) => {
      if (idx !== index) return r;
      const current = parseRoles(r.appliesTo);
      const active = current.includes(role);
      const next = active ? current.filter(x => x !== role) : [...current, role];
      return { ...r, appliesTo: next.join(', ') };
    }));
  }

  function changeAppliesTo(index: number, appliesTo: string) {
    setActionRows(rows => rows.map((r, idx) => (idx === index ? { ...r, appliesTo } : r)));
  }

  const showGithubWarning = type === 'upgrade' && !linkRows.some(row => GH_RELEASE.test(row.url));

  return (
    <div className="card compose-grid">
      <div>
        <h2>New announcement</h2>

        <form method="GET" action="/admin" className="start-from-picker">
          <label htmlFor="from">Start from</label>
          <select
            id="from"
            name="from"
            defaultValue=""
            onChange={e => goto(e.target.value)}
            className="select-styled"
          >
            <option value="">Start from blank</option>
            {templates.length > 0 && (
              <optgroup label="Saved templates">
                {templates.map(t => (
                  <option key={t.id} value={`template:${t.id}`}>{t.name}</option>
                ))}
              </optgroup>
            )}
            {recentAnnouncements.length > 0 && (
              <optgroup label="Past announcements">
                {recentAnnouncements.map(a => (
                  <option key={a.id} value={`announcement:${a.id}`}>{a.title}</option>
                ))}
              </optgroup>
            )}
          </select>
          <noscript><button type="submit">Go</button></noscript>
        </form>
        {editingId ? (
          <div className="notice">
            <p>Editing announcement {editingId}. Saving creates a new revision; its public URL will not change.</p>
            <p>
              {selectedRoleIds.length > 0
                ? `Currently notifying: ${selectedRoleIds
                    .map(id => [...BUILTIN_ROLES, ...discordRoles].find(r => r.id === id)?.name ?? id)
                    .map(name => `@${name}`)
                    .join(', ')}.`
                : 'No roles are currently selected to be notified.'}
            </p>
          </div>
        ) : prefill && (
          <div className="notice">
            <p>Prefilled from a saved template or past announcement. Deadlines are cleared — set new ones below.</p>
          </div>
        )}

        {result?.error && <div className="notice"><p>Error: {result.error}</p></div>}

        <form action={formAction} ref={formRef}>
          <label htmlFor="title">Title</label>
          <input
            id="title"
            type="text"
            name="title"
            placeholder="v5.1.0 release"
            value={title}
            onChange={e => setTitle(e.target.value)}
            required
          />

          <div className="field-row">
            <label htmlFor="slug">Public URL</label>
            <input
              id="slug"
              name="slug"
              value={slug}
              onChange={e => { setSlugTouched(true); setSlug(e.target.value); }}
              onBlur={e => setSlug(normalizeSlug(e.target.value))}
              aria-describedby="slug-hint"
              aria-invalid={slugTouched && !!slugError(slug)}
              readOnly={!!editingId}
            />
            <p id="slug-hint" className="hint">
              <code>/a/{slug || '…'}</code>{' '}
              {editingId ? '— fixed for this announcement.' : '— permanent once published.'}
            </p>
            {!editingId && slugTouched && slugError(slug) && (
              <p role="alert" className="hint">{slugError(slug)}</p>
            )}
          </div>

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
                <input
                  type="radio"
                  name="severity"
                  value={v}
                  checked={v === severity}
                  onChange={() => setSeverity(v)}
                /> {v}
              </label>
            ))}
          </fieldset>

          <fieldset className="role-select">
            <legend>Notify Discord roles</legend>
            {BUILTIN_ROLES.map(r => (
              <label className="check role-select-builtin" key={r.id}>
                <input
                  type="checkbox"
                  name="mentionRoleIds"
                  value={r.id}
                  checked={selectedRoleIds.includes(r.id)}
                  onChange={e => { setRolesTouched(true); toggleMentionRole(r.id, e.target.checked); }}
                />
                @{r.name}
              </label>
            ))}
            {discordRoles.length === 0 ? (
              <p className="hint">No named roles are configured for any Discord destination.</p>
            ) : (
              discordRoles.map(r => (
                <label className="check" key={r.id}>
                  <input
                    type="checkbox"
                    name="mentionRoleIds"
                    value={r.id}
                    checked={selectedRoleIds.includes(r.id)}
                    onChange={e => { setRolesTouched(true); toggleMentionRole(r.id, e.target.checked); }}
                  />
                  @{r.name}
                </label>
              ))
            )}
            <p className="hint">
              Selected roles are notified on Discord. Other channels are unaffected.
              Check the Discord preview to confirm. Named roles are on by default for
              critical announcements; @everyone and @here are never on by default —
              select them yourself when a critical announcement needs the whole server.
            </p>
          </fieldset>

          <fieldset>
            <legend>Networks</legend>
            {NETWORKS.map(v => box('networks', v, prefill ? prefill.networks.includes(v) : true))}
          </fieldset>
          <fieldset>
            <legend>Audience</legend>
            {AUDIENCES.map(v => box('audiences', v, prefill ? prefill.audiences.includes(v) : v === 'operators'))}
          </fieldset>

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
            defaultValue={prefill?.bodyMd ?? ''}
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
              <ActionRowFields
                key={row.key}
                row={row}
                index={i}
                onToggleRole={toggleRole}
                onChangeAppliesTo={changeAppliesTo}
                onRemove={key => setActionRows(rows => rows.filter(r => r.key !== key))}
              />
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() => setActionRows(rows => [...rows, { key: nextActionKey.current++, action: '', deadline: '', appliesTo: '' }])}
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
                  defaultValue={row.label}
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
              onClick={() => setLinkRows(rows => [...rows, { key: nextLinkKey.current++, label: '', url: '' }])}
            >
              Add link
            </button>
          </fieldset>

          <div>
            <button type="submit" disabled={pending}>
              {pending ? 'Saving…' : editingId ? 'Save revision' : 'Save draft'}
            </button>
          </div>
        </form>

        <div className="save-as-template">
          <label htmlFor="templateName">Save as template</label>
          <div className="row-repeat">
            <input
              id="templateName"
              type="text"
              placeholder="Template name (e.g. Standard upgrade)"
              value={templateName}
              onChange={e => { setTemplateName(e.target.value); setSaveTemplateResult(undefined); }}
            />
            <button
              type="button"
              className="secondary"
              disabled={saveTemplatePending || !templateName.trim()}
              onClick={handleSaveTemplate}
            >
              {saveTemplatePending ? 'Saving…' : 'Save template'}
            </button>
          </div>
          {saveTemplateResult?.ok && <p className="muted">Template saved.</p>}
          {saveTemplateResult?.error && <div className="notice"><p>Error: {saveTemplateResult.error}</p></div>}
        </div>
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
        {previewResult?.preview?.error && (
          <div className="notice"><p>Error: {previewResult.preview.error}</p></div>
        )}
        {previewResult?.preview?.warnings?.map(w => (
          <div className="notice" key={w}><p>{w}</p></div>
        ))}

        <div className="preview-tabs" role="tablist" style={{ marginTop: 14 }}>
          {previewChannels.map(ch => (
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

        <div className="preview-mode" role="group" aria-label="Preview mode">
          {(['rendered', 'raw'] as PreviewMode[]).map(m => (
            <button
              type="button"
              key={m}
              aria-pressed={previewMode === m}
              data-state={previewMode === m ? 'active' : 'inactive'}
              onClick={() => setPreviewMode(m)}
            >
              {m === 'rendered' ? 'Rendered' : 'Raw payload'}
            </button>
          ))}
        </div>

        <div className="preview-panel" role="tabpanel">
          {!previewResult?.preview || previewResult.preview.error ? (
            <p className="preview-empty">
              {previewResult?.preview?.error
                ? 'Fix the validation error above, then refresh the preview.'
                : 'Click "Refresh preview" to see how this announcement will render on each channel.'}
            </p>
          ) : (
            <PreviewPane channel={previewTab} preview={previewResult.preview} mode={previewMode} />
          )}
        </div>
      </div>
    </div>
  );
}
