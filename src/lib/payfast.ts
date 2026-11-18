import { createHash } from 'node:crypto';
import type { Order } from './types.ts';

// PayFast helpers: payment links, ITN (webhook) signature checks and server-side validation.
// Docs: https://developers.payfast.co.za/docs

/** PHP-style urlencode, which PayFast requires for signatures (space -> "+", uppercase hex). */
export function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

type Field = readonly [string, string];

function paramString(fields: readonly Field[]): string {
  return fields.map(([k, v]) => `${k}=${phpUrlEncode(v.trim())}`).join('&');
}

/** md5 over the ordered parameter string, with the passphrase appended when one is set. */
export function sign(fields: readonly Field[], passphrase: string): string {
  let base = paramString(fields);
  if (passphrase) base += `&passphrase=${phpUrlEncode(passphrase.trim())}`;
  return createHash('md5').update(base).digest('hex');
}

export function host(sandbox: boolean): string {
  return sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
}

export interface PayFastConfig {
  merchantId: string;
  merchantKey: string;
  passphrase: string;
  sandbox: boolean;
  notifyUrl: string;
  returnUrl?: string;
  cancelUrl?: string;
}

/** A hosted PayFast checkout link for one order. Field order matters for the signature. */
export function buildPaymentUrl(order: Order, cfg: PayFastConfig): string {
  const [firstName = '', ...rest] = order.customerName.trim().split(/\s+/);
  const candidates: Field[] = [
    ['merchant_id', cfg.merchantId],
    ['merchant_key', cfg.merchantKey],
    ['return_url', cfg.returnUrl ?? ''],
    ['cancel_url', cfg.cancelUrl ?? ''],
    ['notify_url', cfg.notifyUrl],
    ['name_first', firstName.slice(0, 100)],
    ['name_last', rest.join(' ').slice(0, 100)],
    ['m_payment_id', String(order.orderNumber)],
    ['amount', (order.totalCents / 100).toFixed(2)],
    ['item_name', `Order #${order.orderNumber}`],
  ];
  const fields = candidates.filter(([, v]) => v.trim() !== '');
  const signature = sign(fields, cfg.passphrase);
  return `https://${host(cfg.sandbox)}/eng/process?${paramString(fields)}&signature=${signature}`;
}

/** Check an ITN body's signature. Uses the fields in the order PayFast sent them. */
export function verifyItnSignature(rawBody: string, passphrase: string): boolean {
  const params = new URLSearchParams(rawBody);
  const received = params.get('signature');
  if (!received) return false;
  const fields: Field[] = [];
  for (const [key, value] of params.entries()) {
    if (key !== 'signature') fields.push([key, value]);
  }
  return sign(fields, passphrase) === received.toLowerCase();
}

/** Ask PayFast to confirm it really sent this ITN (server-to-server). */
export async function validateItnWithPayFast(rawBody: string, sandbox: boolean): Promise<boolean> {
  const params = new URLSearchParams(rawBody);
  params.delete('signature');
  const res = await fetch(`https://${host(sandbox)}/eng/query/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return (await res.text()).trim() === 'VALID';
}

export interface Itn {
  orderNumber: number;
  paymentStatus: string;
  amountGrossCents: number;
  pfPaymentId: string;
}

export function parseItn(rawBody: string): Itn | undefined {
  const p = new URLSearchParams(rawBody);
  const orderNumber = Number(p.get('m_payment_id'));
  const gross = Number(p.get('amount_gross'));
  const status = p.get('payment_status');
  if (!Number.isInteger(orderNumber) || !Number.isFinite(gross) || !status) return undefined;
  return {
    orderNumber,
    paymentStatus: status,
    amountGrossCents: Math.round(gross * 100),
    pfPaymentId: p.get('pf_payment_id') ?? '',
  };
}
