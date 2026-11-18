import type { CartLine, OrderItem } from './types.ts';

export interface Product {
  sku: string;
  name: string; // keep <= 24 chars: it is used as a WhatsApp list row title
  description: string; // keep <= 72 chars
  priceCents: number;
}

// PLACEHOLDER PRODUCTS AND PRICES - replace with the shop's real range.
// WhatsApp list messages allow at most 10 rows, so keep this to 10 products or fewer.
export const CATALOG: readonly Product[] = [
  { sku: 'ORIG-250', name: 'Original biltong 250g', description: 'Classic beef biltong, sliced', priceCents: 11000 },
  { sku: 'ORIG-500', name: 'Original biltong 500g', description: 'Classic beef biltong, sliced', priceCents: 21000 },
  { sku: 'CHIL-250', name: 'Chilli biltong 250g', description: 'Beef biltong with a chilli kick', priceCents: 11500 },
  { sku: 'CHIL-500', name: 'Chilli biltong 500g', description: 'Beef biltong with a chilli kick', priceCents: 22000 },
  { sku: 'DROE-250', name: 'Droewors 250g', description: 'Dried beef sausage', priceCents: 10500 },
  { sku: 'DROE-500', name: 'Droewors 500g', description: 'Dried beef sausage', priceCents: 20000 },
  { sku: 'SNAP-200', name: 'Biltong snap sticks 200g', description: 'Thin, crunchy snacking sticks', priceCents: 9500 },
];

// Delivery: flat fee, free when the goods total reaches the threshold.
export const DELIVERY = {
  flatFeeCents: 8000,
  freeOverCents: 80000,
} as const;

export const MAX_QTY_PER_LINE = 20;

export function getProduct(sku: string): Product | undefined {
  return CATALOG.find((p) => p.sku === sku);
}

export interface Totals {
  items: OrderItem[];
  subtotalCents: number;
  deliveryCents: number;
  totalCents: number;
}

/** Price a cart. Unknown SKUs throw, so a stale cart can never be silently mispriced. */
export function calcTotals(lines: readonly CartLine[]): Totals {
  const items: OrderItem[] = lines.map((line) => {
    const product = getProduct(line.sku);
    if (!product) throw new Error(`Unknown product: ${line.sku}`);
    if (!Number.isInteger(line.qty) || line.qty < 1) throw new Error(`Invalid quantity for ${line.sku}`);
    return { sku: product.sku, name: product.name, qty: line.qty, unitPriceCents: product.priceCents };
  });
  const subtotalCents = items.reduce((sum, i) => sum + i.qty * i.unitPriceCents, 0);
  const deliveryCents = subtotalCents === 0 || subtotalCents >= DELIVERY.freeOverCents ? 0 : DELIVERY.flatFeeCents;
  return { items, subtotalCents, deliveryCents, totalCents: subtotalCents + deliveryCents };
}

/** 125000 -> "R1 250", 125050 -> "R1 250.50". */
export function formatRand(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const rands = Math.floor(abs / 100);
  const rem = abs % 100;
  const grouped = String(rands).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${negative ? '-' : ''}R${grouped}${rem ? '.' + String(rem).padStart(2, '0') : ''}`;
}
