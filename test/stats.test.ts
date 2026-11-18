import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ordersToCsv } from '../src/lib/csv.ts';
import { computeMonthStats } from '../src/lib/stats.ts';
import { daysInMonth, isMonthKey, localDay, localMonth } from '../src/lib/time.ts';
import { makeOrder } from './helpers.ts';

describe('time helpers (SAST = UTC+2)', () => {
  it('rolls a late-evening UTC timestamp into the next SAST day', () => {
    assert.equal(localDay('2026-11-17T22:30:00.000Z'), '2026-11-18');
  });
  it('rolls month end over in SAST', () => {
    assert.equal(localMonth('2026-11-30T22:30:00.000Z'), '2026-12');
    assert.equal(localMonth('2026-11-30T21:59:00.000Z'), '2026-11');
  });
  it('knows month lengths, including leap years', () => {
    assert.equal(daysInMonth('2026-11'), 30);
    assert.equal(daysInMonth('2028-02'), 29);
    assert.equal(daysInMonth('2027-02'), 28);
  });
  it('validates month keys', () => {
    assert.ok(isMonthKey('2026-11'));
    assert.ok(!isMonthKey('2026-13'));
    assert.ok(!isMonthKey('2026-1'));
  });
});

describe('computeMonthStats', () => {
  const orders = [
    makeOrder({ orderNumber: 1, status: 'paid', totalCents: 50000, createdAt: '2026-11-02T08:00:00.000Z' }),
    makeOrder({ orderNumber: 2, status: 'delivered', totalCents: 30000, createdAt: '2026-11-02T09:00:00.000Z' }),
    makeOrder({ orderNumber: 3, status: 'awaiting_payment', totalCents: 20000, createdAt: '2026-11-05T09:00:00.000Z' }),
    makeOrder({ orderNumber: 4, status: 'cancelled', totalCents: 99999, createdAt: '2026-11-06T09:00:00.000Z' }),
    makeOrder({ orderNumber: 5, status: 'shipped', totalCents: 10000, createdAt: '2026-10-31T22:30:00.000Z' }), // 00:30 on 1 Nov in SAST
    makeOrder({ orderNumber: 6, status: 'paid', totalCents: 77777, createdAt: '2026-10-15T09:00:00.000Z' }), // October, ignored
  ];
  const stats = computeMonthStats(orders, '2026-11');

  it('counts revenue only from paid, shipped and delivered orders', () => {
    assert.equal(stats.revenueCents, 50000 + 30000 + 10000);
  });
  it('counts orders excluding cancelled, and respects the SAST month boundary', () => {
    assert.equal(stats.orderCount, 4);
    assert.equal(stats.cancelledCount, 1);
  });
  it('averages over paid orders only', () => {
    assert.equal(stats.averageOrderCents, Math.round(90000 / 3));
  });
  it('tracks awaiting payment', () => {
    assert.equal(stats.awaitingPaymentCount, 1);
    assert.equal(stats.awaitingPaymentCents, 20000);
  });
  it('returns one bucket per day of the month', () => {
    assert.equal(stats.ordersPerDay.length, 30);
    assert.equal(stats.ordersPerDay.find((d) => d.day === '2026-11-02')?.count, 2);
    assert.equal(stats.ordersPerDay.find((d) => d.day === '2026-11-01')?.count, 1);
    assert.equal(stats.ordersPerDay.find((d) => d.day === '2026-11-03')?.count, 0);
  });
  it('ranks top products by quantity', () => {
    assert.equal(stats.topProducts[0]?.sku, 'ORIG-500');
    assert.equal(stats.topProducts[0]?.qty, 8); // 4 counted orders x 2
  });
  it('handles an empty month', () => {
    const empty = computeMonthStats([], '2026-12');
    assert.equal(empty.revenueCents, 0);
    assert.equal(empty.averageOrderCents, 0);
    assert.equal(empty.ordersPerDay.length, 31);
  });
});

describe('ordersToCsv', () => {
  it('writes a header, formats rands and quotes awkward text', () => {
    const csv = ordersToCsv([makeOrder({ customerName: 'Pieter "PJ" van der Merwe, Jr' })]);
    const [header, row] = csv.trim().split('\r\n');
    assert.match(header!, /^Order,Date,Customer/);
    assert.match(row!, /^1001,2026-11-17,"Pieter ""PJ"" van der Merwe, Jr"/);
    assert.match(row!, /500\.00,Awaiting payment$/);
  });
  it('neutralises spreadsheet formulas in customer-supplied text', () => {
    const csv = ordersToCsv([makeOrder({ customerName: '=HYPERLINK("http://evil")' })]);
    assert.ok(!csv.includes(',=HYPERLINK'));
    assert.ok(csv.includes(`'=HYPERLINK`));
  });
});
