import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CATALOG, DELIVERY, calcTotals, formatRand } from '../src/lib/catalog.ts';

describe('formatRand', () => {
  it('formats whole rands with space thousands separators', () => {
    assert.equal(formatRand(0), 'R0');
    assert.equal(formatRand(11000), 'R110');
    assert.equal(formatRand(125000), 'R1 250');
    assert.equal(formatRand(123456700), 'R1 234 567');
  });
  it('shows cents only when present', () => {
    assert.equal(formatRand(125050), 'R1 250.50');
    assert.equal(formatRand(105), 'R1.05');
  });
});

describe('calcTotals', () => {
  it('adds the flat delivery fee below the free-delivery threshold', () => {
    const t = calcTotals([{ sku: 'ORIG-250', qty: 2 }]);
    assert.equal(t.subtotalCents, 22000);
    assert.equal(t.deliveryCents, DELIVERY.flatFeeCents);
    assert.equal(t.totalCents, 22000 + DELIVERY.flatFeeCents);
  });

  it('makes delivery free once the threshold is reached', () => {
    const t = calcTotals([{ sku: 'ORIG-500', qty: 4 }]); // R840
    assert.ok(t.subtotalCents >= DELIVERY.freeOverCents);
    assert.equal(t.deliveryCents, 0);
    assert.equal(t.totalCents, t.subtotalCents);
  });

  it('snapshots name and price onto each item', () => {
    const t = calcTotals([{ sku: 'DROE-250', qty: 1 }]);
    assert.deepEqual(t.items[0], { sku: 'DROE-250', name: 'Droewors 250g', qty: 1, unitPriceCents: 10500 });
  });

  it('rejects unknown products and bad quantities', () => {
    assert.throws(() => calcTotals([{ sku: 'NOPE', qty: 1 }]), /Unknown product/);
    assert.throws(() => calcTotals([{ sku: 'ORIG-250', qty: 0 }]), /Invalid quantity/);
    assert.throws(() => calcTotals([{ sku: 'ORIG-250', qty: 1.5 }]), /Invalid quantity/);
  });
});

describe('catalog', () => {
  it('fits WhatsApp list limits (10 rows, 24 char titles, 72 char descriptions)', () => {
    assert.ok(CATALOG.length <= 10);
    for (const p of CATALOG) {
      assert.ok(p.name.length <= 24, `${p.name} is too long for a list row title`);
      assert.ok(`${formatRand(p.priceCents)} - ${p.description}`.length <= 72, `${p.sku} row description is over 72 chars`);
    }
  });
  it('has unique SKUs', () => {
    assert.equal(new Set(CATALOG.map((p) => p.sku)).size, CATALOG.length);
  });
});
