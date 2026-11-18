import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { config } from '../lib/config.ts';
import { ordersToCsv } from '../lib/csv.ts';
import * as db from '../lib/db.ts';
import {
  OrderNotFoundError,
  changeStatus,
  paymentLinkFor,
  sendInvoiceToCustomer,
  sendPaymentLinkToCustomer,
} from '../lib/orderService.ts';
import { ACTIVE_STATUSES, InvalidTransitionError, allowedNext, isOrderStatus } from '../lib/orders.ts';
import { computeMonthStats } from '../lib/stats.ts';
import { currentMonth, isMonthKey } from '../lib/time.ts';
import { invoiceDownloadUrl } from '../lib/storage.ts';
import { WhatsAppError, OUTSIDE_WINDOW_CODE } from '../lib/whatsapp.ts';
import type { Order, OrderStatus } from '../lib/types.ts';

// JSON API for the admin website. Every request needs a valid Cognito access token.
//
//   GET  /stats?month=YYYY-MM
//   GET  /orders                         active orders (awaiting payment, paid, shipped), newest first
//   GET  /orders?month=YYYY-MM&q=&status=   history for a month, optional search / status filter
//   GET  /orders/{n}
//   POST /orders/{n}/status              {"status": "shipped", "notify": true}
//   POST /orders/{n}/resend-invoice
//   POST /orders/{n}/resend-payment-link
//   GET  /orders/{n}/invoice             -> {"url": "<15 minute signed link>"}
//   GET  /export?month=YYYY-MM           CSV download

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
function jwtVerifier() {
  verifier ??= CognitoJwtVerifier.create({
    userPoolId: config.admin.userPoolId(),
    clientId: config.admin.clientId(),
    tokenUse: 'access',
  });
  return verifier;
}

async function authenticate(event: APIGatewayProxyEventV2): Promise<void> {
  const header = event.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Missing bearer token');
  try {
    await jwtVerifier().verify(token);
  } catch {
    throw new HttpError(401, 'Invalid or expired token');
  }
}

const json = (status: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

function parseBody(event: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!event.body) return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

function monthParam(event: APIGatewayProxyEventV2): string {
  const month = event.queryStringParameters?.['month'] ?? currentMonth();
  if (!isMonthKey(month)) throw new HttpError(400, 'month must look like 2026-11');
  return month;
}

async function loadOrder(raw: string): Promise<Order> {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Invalid order number');
  const order = await db.getOrder(n);
  if (!order) throw new HttpError(404, `Order ${n} not found`);
  return order;
}

/** What the admin UI needs to draw the right buttons for an order. */
function present(order: Order) {
  return { ...order, allowedNextStatuses: allowedNext(order.status) };
}

async function activeOrders(): Promise<Order[]> {
  const lists = await Promise.all(ACTIVE_STATUSES.map((s) => db.listOrdersByStatus(s)));
  return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function monthOrders(event: APIGatewayProxyEventV2): Promise<Order[]> {
  const month = monthParam(event);
  const status = event.queryStringParameters?.['status'];
  const q = (event.queryStringParameters?.['q'] ?? '').trim().toLowerCase();
  if (status && !isOrderStatus(status)) throw new HttpError(400, 'Unknown status');
  let orders = await db.listOrdersByMonth(month);
  if (status) orders = orders.filter((o) => o.status === (status as OrderStatus));
  if (q) {
    orders = orders.filter(
      (o) =>
        String(o.orderNumber).includes(q.replace('#', '')) ||
        o.customerName.toLowerCase().includes(q) ||
        o.customerWaId.includes(q),
    );
  }
  return orders;
}

async function route(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/\/+$/, '') || '/';
  const params = event.queryStringParameters ?? {};

  if (method === 'GET' && path === '/stats') {
    const month = monthParam(event);
    return json(200, computeMonthStats(await db.listOrdersByMonth(month), month));
  }

  if (method === 'GET' && path === '/orders') {
    const orders = params['month'] || params['q'] || params['status'] ? await monthOrders(event) : await activeOrders();
    return json(200, { orders: orders.map(present) });
  }

  if (method === 'GET' && path === '/export') {
    const month = monthParam(event);
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="orders-${month}.csv"` },
      body: ordersToCsv(await db.listOrdersByMonth(month)),
    };
  }

  const match = /^\/orders\/(\d+)(?:\/([a-z-]+))?$/.exec(path);
  if (match) {
    const raw = match[1] ?? '';
    const action = match[2];

    if (method === 'GET' && !action) return json(200, { order: present(await loadOrder(raw)) });

    if (method === 'GET' && action === 'invoice') {
      const order = await loadOrder(raw);
      if (!order.invoiceKey) throw new HttpError(404, 'No invoice has been generated for this order yet');
      return json(200, { url: await invoiceDownloadUrl(order.invoiceKey, `Invoice-INV-${order.orderNumber}.pdf`) });
    }

    if (method === 'POST' && action === 'status') {
      const body = parseBody(event);
      if (!isOrderStatus(body['status'])) throw new HttpError(400, 'Unknown status');
      const result = await changeStatus(Number(raw), body['status'], new Date().toISOString(), body['notify'] !== false);
      return json(200, { order: present(result.order), notified: result.notified });
    }

    if (method === 'POST' && action === 'resend-invoice') {
      const order = await loadOrder(raw);
      await sendInvoiceToCustomer(order, `Invoice for order #${order.orderNumber}`);
      return json(200, { ok: true });
    }

    if (method === 'POST' && action === 'resend-payment-link') {
      const order = await loadOrder(raw);
      if (order.status !== 'awaiting_payment') throw new HttpError(409, 'This order is not waiting for payment');
      await sendPaymentLinkToCustomer(order);
      // Also return the link so the shop owner can copy it into another chat if WhatsApp refuses.
      return json(200, { ok: true, paymentUrl: paymentLinkFor(order) });
    }
  }

  throw new HttpError(404, 'Not found');
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    await authenticate(event);
    return await route(event);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    if (err instanceof OrderNotFoundError) return json(404, { error: err.message });
    if (err instanceof InvalidTransitionError) return json(409, { error: err.message });
    if (err instanceof db.StaleOrderError) return json(409, { error: err.message });
    if (err instanceof WhatsAppError) {
      const hint =
        err.code === OUTSIDE_WINDOW_CODE
          ? 'WhatsApp only allows free-form messages within 24 hours of the customer last writing. Use the payment link / invoice link manually or send an approved template.'
          : err.message;
      return json(502, { error: hint, code: err.code });
    }
    console.error('Unhandled admin API error', err);
    return json(500, { error: 'Something went wrong' });
  }
}
