import type { Order, OrderStatus } from './types.ts';

// The order state machine. Every status change goes through applyTransition,
// so the admin API, the payment webhook and the WhatsApp flow all share the same rules.
//
//   awaiting_payment -> paid -> shipped -> delivered
//          \             \
//           +-> cancelled <+

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  awaiting_payment: ['paid', 'cancelled'],
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export const ACTIVE_STATUSES: readonly OrderStatus[] = ['awaiting_payment', 'paid', 'shipped'];
export const ALL_STATUSES: readonly OrderStatus[] = [...ACTIVE_STATUSES, 'delivered', 'cancelled'];
/** Statuses that count as money received. */
export const REVENUE_STATUSES: readonly OrderStatus[] = ['paid', 'shipped', 'delivered'];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ALL_STATUSES as readonly string[]).includes(value);
}

export function allowedNext(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Cannot move an order from "${from}" to "${to}"`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

const TIMESTAMP_FIELD: Partial<Record<OrderStatus, keyof Order>> = {
  paid: 'paidAt',
  shipped: 'shippedAt',
  delivered: 'deliveredAt',
  cancelled: 'cancelledAt',
};

/** Returns a new order in the target status, or throws InvalidTransitionError. */
export function applyTransition(order: Order, to: OrderStatus, now: string): Order {
  if (!canTransition(order.status, to)) throw new InvalidTransitionError(order.status, to);
  const next: Order = { ...order, status: to, updatedAt: now };
  const field = TIMESTAMP_FIELD[to];
  if (field) (next as unknown as Record<string, unknown>)[field] = now;
  return next;
}

export function statusLabel(status: OrderStatus): string {
  switch (status) {
    case 'awaiting_payment':
      return 'Awaiting payment';
    case 'paid':
      return 'Paid';
    case 'shipped':
      return 'Shipped';
    case 'delivered':
      return 'Delivered';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Customer-facing WhatsApp text for a status change. */
export function statusMessage(order: Order): string {
  const ref = `#${order.orderNumber}`;
  switch (order.status) {
    case 'awaiting_payment':
      return `Order ${ref} is waiting for payment.`;
    case 'paid':
      return `Payment received for order ${ref}. Thank you! We'll get it packed and sent out soon.`;
    case 'shipped':
      return `Good news - order ${ref} is on its way to you.`;
    case 'delivered':
      return `Order ${ref} has been delivered. Enjoy! Message us any time to order again.`;
    case 'cancelled':
      return `Order ${ref} has been cancelled. If this is a surprise, reply here and we'll sort it out.`;
  }
}
