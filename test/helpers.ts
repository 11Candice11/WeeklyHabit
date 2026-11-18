import type { IncomingMessage, Order } from '../src/lib/types.ts';

export const NOW = '2026-11-17T10:00:00.000Z';

export function text(body: string, from = '27821234567', name = 'Thandi Nkosi'): IncomingMessage {
  return { id: `wamid.${Math.random()}`, from, name, kind: 'text', text: body };
}

export function tap(replyId: string, from = '27821234567', name = 'Thandi Nkosi'): IncomingMessage {
  return { id: `wamid.${Math.random()}`, from, name, kind: 'button', replyId, text: replyId };
}

export function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderNumber: 1001,
    customerWaId: '27821234567',
    customerName: 'Thandi Nkosi',
    address: '12 Protea Road, Sea Point, Cape Town, 8005',
    items: [{ sku: 'ORIG-500', name: 'Original biltong 500g', qty: 2, unitPriceCents: 21000 }],
    subtotalCents: 42000,
    deliveryCents: 8000,
    totalCents: 50000,
    status: 'awaiting_payment',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
