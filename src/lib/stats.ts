import { daysInMonth, localDay, localMonth } from './time.ts';
import { REVENUE_STATUSES } from './orders.ts';
import type { Order } from './types.ts';

export interface MonthStats {
  month: string;
  /** Money received: orders that are paid, shipped or delivered. */
  revenueCents: number;
  /** Orders placed this month, cancelled ones excluded. */
  orderCount: number;
  /** Revenue divided by the number of paid orders (0 if none). */
  averageOrderCents: number;
  awaitingPaymentCount: number;
  awaitingPaymentCents: number;
  cancelledCount: number;
  /** One entry per calendar day of the month. */
  ordersPerDay: { day: string; count: number }[];
  topProducts: { sku: string; name: string; qty: number; revenueCents: number }[];
}

/** Compute the dashboard numbers for one month ("YYYY-MM", SAST) from that month's orders. */
export function computeMonthStats(orders: readonly Order[], month: string): MonthStats {
  const inMonth = orders.filter((o) => localMonth(o.createdAt) === month);
  const counted = inMonth.filter((o) => o.status !== 'cancelled');
  const paid = counted.filter((o) => (REVENUE_STATUSES as readonly string[]).includes(o.status));
  const awaiting = counted.filter((o) => o.status === 'awaiting_payment');

  const revenueCents = paid.reduce((sum, o) => sum + o.totalCents, 0);

  const perDay = new Map<string, number>();
  const total = daysInMonth(month);
  for (let d = 1; d <= total; d++) perDay.set(`${month}-${String(d).padStart(2, '0')}`, 0);
  for (const o of counted) {
    const day = localDay(o.createdAt);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const products = new Map<string, { sku: string; name: string; qty: number; revenueCents: number }>();
  for (const o of counted) {
    for (const item of o.items) {
      const entry = products.get(item.sku) ?? { sku: item.sku, name: item.name, qty: 0, revenueCents: 0 };
      entry.qty += item.qty;
      entry.revenueCents += item.qty * item.unitPriceCents;
      products.set(item.sku, entry);
    }
  }

  return {
    month,
    revenueCents,
    orderCount: counted.length,
    averageOrderCents: paid.length ? Math.round(revenueCents / paid.length) : 0,
    awaitingPaymentCount: awaiting.length,
    awaitingPaymentCents: awaiting.reduce((sum, o) => sum + o.totalCents, 0),
    cancelledCount: inMonth.length - counted.length,
    ordersPerDay: [...perDay.entries()].map(([day, count]) => ({ day, count })),
    topProducts: [...products.values()].sort((a, b) => b.qty - a.qty || b.revenueCents - a.revenueCents).slice(0, 5),
  };
}
