export interface EmailMessage {
  to: string; subject: string; text: string; html?: string; headers?: Record<string, string>;
}
export interface EmailSender {
  name: string;
  send(msg: EmailMessage): Promise<void>;
}

type HttpOpts = { apiKey?: string; from?: string; apiBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

async function postJson(
  doFetch: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, label: string,
): Promise<void> {
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const rawDetail = await res.text().catch(() => '');
    const detail = rawDetail.length > 200 ? `${rawDetail.slice(0, 200)}…` : rawDetail;
    throw new Error(`${label} send failed: HTTP ${res.status} ${detail}`.trim());
  }
}

export function makeResendSender(opts: HttpOpts = {}): EmailSender {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiBase = (opts.apiBase ?? 'https://api.resend.com').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return {
    name: 'resend',
    async send(msg: EmailMessage): Promise<void> {
      const key = opts.apiKey ?? process.env.RESEND_API_KEY;
      if (!key) throw new Error('RESEND_API_KEY is not set');
      const from = opts.from ?? process.env.EMAIL_FROM;
      if (!from) throw new Error('EMAIL_FROM is not set');
      await postJson(doFetch, `${apiBase}/emails`, { authorization: `Bearer ${key}` },
        { from, to: [msg.to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}), ...(msg.headers ? { headers: msg.headers } : {}) },
        timeoutMs, 'resend');
    },
  };
}

export function makeBrevoSender(opts: HttpOpts & { fromName?: string } = {}): EmailSender {
  const doFetch = opts.fetchImpl ?? fetch;
  const apiBase = (opts.apiBase ?? 'https://api.brevo.com').replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return {
    name: 'brevo',
    async send(msg: EmailMessage): Promise<void> {
      const key = opts.apiKey ?? process.env.BREVO_API_KEY;
      if (!key) throw new Error('BREVO_API_KEY is not set');
      const from = opts.from ?? process.env.EMAIL_FROM;
      if (!from) throw new Error('EMAIL_FROM is not set');
      const name = opts.fromName ?? process.env.EMAIL_FROM_NAME;
      await postJson(doFetch, `${apiBase}/v3/smtp/email`, { 'api-key': key },
        {
          sender: { email: from, ...(name ? { name } : {}) },
          to: [{ email: msg.to }],
          subject: msg.subject, textContent: msg.text,
          ...(msg.html ? { htmlContent: msg.html } : {}),
          ...(msg.headers ? { headers: msg.headers } : {}),
        },
        timeoutMs, 'brevo');
    },
  };
}

/**
 * Dev sender: prints the whole message instead of sending it. The body matters —
 * confirmation and unsubscribe links only reach a developer this way.
 */
export function makeConsoleSender(): EmailSender {
  return {
    name: 'console',
    async send(msg: EmailMessage): Promise<void> {
      console.log(
        `\n${'='.repeat(72)}\n[email:console] to: ${msg.to}\nsubject: ${msg.subject}\n${'-'.repeat(72)}\n${msg.text}${'='.repeat(72)}\n`,
      );
    },
  };
}

export function senderFromEnv(opts: HttpOpts & { fromName?: string } = {}): EmailSender {
  const provider = (process.env.ESP_PROVIDER ?? 'console').toLowerCase();
  if (provider === 'resend') return makeResendSender(opts);
  if (provider === 'brevo') return makeBrevoSender(opts);
  if (provider === 'console') return makeConsoleSender();
  throw new Error(`unknown ESP_PROVIDER: ${provider}`);
}
