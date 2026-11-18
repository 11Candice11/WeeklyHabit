import { config } from './config.ts';
import { calcTotals } from './catalog.ts';
import * as db from './db.ts';
import { generateInvoicePdf } from './invoice.ts';
import { applyTransition, statusMessage } from './orders.ts';
import { buildPaymentUrl } from './payfast.ts';
import { invoiceKey, putInvoice } from './storage.ts';
import type { CreateOrderAction, Order, OrderStatus } from './types.ts';
import { OUTSIDE_WINDOW_CODE, WhatsAppError, sendDocument, sendTemplate, sendText } from './whatsapp.ts';

// Everything that touches more than one system (DynamoDB + S3 + WhatsApp + PayFast) lives here,
// so the handlers stay thin and every status change is notified the same way.

function payFastConfig() {
  return {
    merchantId: config.payfast.merchantId(),
    merchantKey: config.payfast.merchantKey(),
    passphrase: config.payfast.passphrase(),
    sandbox: config.payfast.sandbox(),
    notifyUrl: config.payfast.notifyUrl(),
    returnUrl: config.payfast.returnUrl() || undefined,
    cancelUrl: config.payfast.cancelUrl() || undefined,
  };
}

export function paymentLinkFor(order: Order): string {
  return buildPaymentUrl(order, payFastConfig());
}

/** Render the invoice PDF for the order's current state and store it in S3. */
export async function renderAndStoreInvoice(order: Order): Promise<{ order: Order; pdf: Uint8Array }> {
  const pdf = await generateInvoicePdf(order, {
    name: config.business.name(),
    contact: config.business.contact(),
    address: config.business.address(),
    bankDetails: config.business.bankDetails(),
  });
  const key = invoiceKey(order.orderNumber);
  await putInvoice(key, pdf);
  return { order: order.invoiceKey === key ? order : { ...order, invoiceKey: key }, pdf };
}

/** Send the invoice PDF to the customer (free-form, so only valid inside the 24h window). */
export async function sendInvoiceToCustomer(order: Order, caption: string): Promise<Order> {
  const rendered = await renderAndStoreInvoice(order);
  await sendDocument(order.customerWaId, rendered.pdf, `Invoice-INV-${order.orderNumber}.pdf`, caption);
  return rendered.order;
}

export async function sendPaymentLinkToCustomer(order: Order): Promise<void> {
  await sendText(
    order.customerWaId,
    `Pay securely online (card, instant EFT):\n${paymentLinkFor(order)}\n\nYour order ships as soon as payment is received.`,
  );
}

/** Create an order from a confirmed cart, then send the invoice and payment link. */
export async function placeOrder(waId: string, action: CreateOrderAction, now: string): Promise<Order> {
  const totals = calcTotals(action.cart);
  const orderNumber = await db.nextOrderNumber();
  let order: Order = {
    orderNumber,
    customerWaId: waId,
    customerName: action.name,
    address: action.address,
    items: totals.items,
    subtotalCents: totals.subtotalCents,
    deliveryCents: totals.deliveryCents,
    totalCents: totals.totalCents,
    status: 'awaiting_payment',
    createdAt: now,
    updatedAt: now,
  };
  await db.createOrder(order);
  await db.putCustomer({ waId, name: action.name, address: action.address, lastOrderNumber: orderNumber });

  // The order exists from here on. If sending fails, the admin can use "resend" - do not lose the order.
  try {
    const firstName = action.name.trim().split(/\s+/)[0] ?? '';
    await sendText(waId, `Thanks${firstName ? ' ' + firstName : ''}! Your order *#${orderNumber}* is in.`);
    order = await sendInvoiceToCustomer(order, `Invoice for order #${orderNumber}`);
    await sendPaymentLinkToCustomer(order);
    if (order.invoiceKey) await db.saveOrder(order, 'awaiting_payment');
  } catch (err) {
    console.error('Order created but sending the invoice/payment link failed', { orderNumber, err });
  }
  return order;
}

/** Notify a customer. Falls back to an approved template when the 24h window has closed. */
export async function notifyCustomer(order: Order, message: string): Promise<'sent' | 'template' | 'failed'> {
  try {
    await sendText(order.customerWaId, message);
    return 'sent';
  } catch (err) {
    const template = config.wa.orderUpdateTemplate();
    if (err instanceof WhatsAppError && err.code === OUTSIDE_WINDOW_CODE && template) {
      try {
        await sendTemplate(order.customerWaId, template, [String(order.orderNumber), message]);
        return 'template';
      } catch (templateErr) {
        console.error('Template notification failed', { orderNumber: order.orderNumber, templateErr });
        return 'failed';
      }
    }
    console.error('Customer notification failed', { orderNumber: order.orderNumber, err });
    return 'failed';
  }
}

export interface StatusChangeResult {
  order: Order;
  notified: 'sent' | 'template' | 'failed' | 'skipped';
}

/** Move an order to a new status (admin action) and tell the customer. */
export async function changeStatus(orderNumber: number, to: OrderStatus, now: string, notify = true): Promise<StatusChangeResult> {
  const existing = await db.getOrder(orderNumber);
  if (!existing) throw new OrderNotFoundError(orderNumber);
  const updated = applyTransition(existing, to, now);
  await db.saveOrder(updated, existing.status);
  const notified = notify ? await notifyCustomer(updated, statusMessage(updated)) : 'skipped';
  return { order: updated, notified };
}

/** Called by the PayFast webhook. Safe to call twice (PayFast retries). */
export async function markPaid(orderNumber: number, paymentRef: string, now: string): Promise<Order | undefined> {
  const existing = await db.getOrder(orderNumber);
  if (!existing) throw new OrderNotFoundError(orderNumber);
  if (existing.status !== 'awaiting_payment') return undefined; // already paid / cancelled / further along
  let paid: Order = { ...applyTransition(existing, 'paid', now), paymentRef };
  await db.saveOrder(paid, 'awaiting_payment');

  // Best effort from here: the money is recorded, so never fail the webhook over a WhatsApp problem.
  try {
    const rendered = await renderAndStoreInvoice(paid);
    paid = rendered.order;
    await sendDocument(paid.customerWaId, rendered.pdf, `Receipt-INV-${paid.orderNumber}.pdf`, statusMessage(paid));
    if (paid.invoiceKey !== existing.invoiceKey) await db.saveOrder(paid, 'paid');
  } catch (err) {
    console.error('Paid receipt could not be sent', { orderNumber, err });
    await notifyCustomer(paid, statusMessage(paid));
  }
  return paid;
}

export class OrderNotFoundError extends Error {
  constructor(orderNumber: number) {
    super(`Order ${orderNumber} not found`);
    this.name = 'OrderNotFoundError';
  }
}
