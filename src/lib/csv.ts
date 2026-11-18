import { localDay } from './time.ts';
import { statusLabel } from './orders.ts';
import type { Order } from './types.ts';

function cell(value: string | number): string {
  let s = String(value);
  // Stop spreadsheet apps treating customer-supplied text as a formula.
  if (/^[=+\-@\t\r]/.test(s) && typeof value === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV export of orders for the admin "Export" button. Amounts are in rands. */
export function ordersToCsv(orders: readonly Order[]): string {
  const header = ['Order', 'Date', 'Customer', 'WhatsApp', 'Items', 'Subtotal (R)', 'Delivery (R)', 'Total (R)', 'Status'];
  const rows = orders.map((o) => [
    o.orderNumber,
    localDay(o.createdAt),
    o.customerName,
    o.customerWaId,
    o.items.map((i) => `${i.qty} x ${i.name}`).join('; '),
    (o.subtotalCents / 100).toFixed(2),
    (o.deliveryCents / 100).toFixed(2),
    (o.totalCents / 100).toFixed(2),
    statusLabel(o.status),
  ]);
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
