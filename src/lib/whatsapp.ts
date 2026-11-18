import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import type { ButtonDef, IncomingMessage, ListRow, OutgoingAction } from './types.ts';

// Thin client for the WhatsApp Business Cloud API plus webhook helpers.

/** Verify Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifySignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  let received: Buffer;
  try {
    received = Buffer.from(header.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

interface WebhookPayload {
  entry?: {
    changes?: {
      value?: {
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: RawMessage[];
        statuses?: { id?: string; status?: string; errors?: { code?: number; title?: string }[] }[];
      };
    }[];
  }[];
}

interface RawMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}

export interface ParsedWebhook {
  messages: IncomingMessage[];
  failedStatuses: { id: string; code?: number; title?: string }[];
}

export function parseWebhook(raw: string): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], failedStatuses: [] };
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw) as WebhookPayload;
  } catch {
    return result;
  }
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);
      }
      for (const m of value.messages ?? []) {
        if (!m.id || !m.from) continue;
        const base = { id: m.id, from: m.from, name: names.get(m.from) };
        if (m.type === 'text') {
          result.messages.push({ ...base, kind: 'text', text: m.text?.body ?? '' });
        } else if (m.type === 'interactive' && m.interactive?.button_reply?.id) {
          result.messages.push({ ...base, kind: 'button', text: m.interactive.button_reply.title, replyId: m.interactive.button_reply.id });
        } else if (m.type === 'interactive' && m.interactive?.list_reply?.id) {
          result.messages.push({ ...base, kind: 'list', text: m.interactive.list_reply.title, replyId: m.interactive.list_reply.id });
        } else {
          result.messages.push({ ...base, kind: 'other' });
        }
      }
      for (const s of value.statuses ?? []) {
        if (s.status === 'failed' && s.id) {
          result.failedStatuses.push({ id: s.id, code: s.errors?.[0]?.code, title: s.errors?.[0]?.title });
        }
      }
    }
  }
  return result;
}

export class WhatsAppError extends Error {
  readonly status: number;
  readonly code?: number;
  constructor(message: string, status: number, code?: number) {
    super(message);
    this.name = 'WhatsAppError';
    this.status = status;
    this.code = code;
  }
}

/** Error code Meta returns when you message a customer outside the 24h window without a template. */
export const OUTSIDE_WINDOW_CODE = 131047;

function baseUrl(): string {
  return `https://graph.facebook.com/${config.wa.apiVersion()}/${config.wa.phoneNumberId()}`;
}

async function call(path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.wa.token()}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: { error?: { message?: string; code?: number } } & Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    // non-JSON error body; fall through to the generic message below
  }
  if (!res.ok) {
    throw new WhatsAppError(body.error?.message ?? `WhatsApp API error ${res.status}`, res.status, body.error?.code);
  }
  return body;
}

async function sendMessage(payload: Record<string, unknown>): Promise<void> {
  await call('/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
  });
}

export function sendText(to: string, body: string): Promise<void> {
  return sendMessage({ to, type: 'text', text: { body, preview_url: true } });
}

export function sendButtons(to: string, body: string, buttons: ButtonDef[]): Promise<void> {
  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body.slice(0, 1024) },
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  });
}

export function sendList(to: string, body: string, buttonText: string, rows: ListRow[]): Promise<void> {
  return sendMessage({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body.slice(0, 1024) },
      action: {
        button: buttonText.slice(0, 20),
        sections: [
          {
            title: 'Products',
            rows: rows.slice(0, 10).map((r) => ({ id: r.id, title: r.title.slice(0, 24), description: r.description?.slice(0, 72) })),
          },
        ],
      },
    },
  });
}

export function sendTemplate(to: string, name: string, bodyParams: string[], language = 'en'): Promise<void> {
  return sendMessage({
    to,
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: bodyParams.length
        ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
        : [],
    },
  });
}

/** Upload a PDF to WhatsApp media and send it as a document message. */
export async function sendDocument(to: string, pdf: Uint8Array, filename: string, caption: string): Promise<void> {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'application/pdf');
  form.append('file', new Blob([pdf as BlobPart], { type: 'application/pdf' }), filename);
  const uploaded = (await call('/media', { method: 'POST', body: form })) as { id?: string };
  if (!uploaded.id) throw new WhatsAppError('Media upload returned no id', 502);
  await sendMessage({ to, type: 'document', document: { id: uploaded.id, filename, caption } });
}

/** Send one reply action from the conversation flow. (create_order / order_status are handled by the worker.) */
export async function sendFlowAction(to: string, action: OutgoingAction): Promise<void> {
  switch (action.type) {
    case 'text':
      return sendText(to, action.body);
    case 'buttons':
      return sendButtons(to, action.body, action.buttons);
    case 'list':
      return sendList(to, action.body, action.buttonText, action.rows);
    default:
      throw new Error(`Action ${action.type} is not a message`);
  }
}
