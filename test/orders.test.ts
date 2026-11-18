import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_STATUSES, InvalidTransitionError, applyTransition, canTransition, isOrderStatus } from '../src/lib/orders.ts';
import { makeOrder } from './helpers.ts';

const LATER = '2026-11-18T08:00:00.000Z';

describe('order state machine', () => {
  it('walks the happy path and stamps each timestamp', () => {
    let order = makeOrder();
    order = applyTransition(order, 'paid', LATER);
    assert.equal(order.status, 'paid');
    assert.equal(order.paidAt, LATER);
    order = applyTransition(order, 'shipped', LATER);
    assert.equal(order.shippedAt, LATER);
    order = applyTransition(order, 'delivered', LATER);
    assert.equal(order.deliveredAt, LATER);
    assert.equal(order.updatedAt, LATER);
  });

  it('does not mutate the original order', () => {
    const original = makeOrder();
    applyTransition(original, 'paid', LATER);
    assert.equal(original.status, 'awaiting_payment');
    assert.equal(original.paidAt, undefined);
  });

  it('allows cancelling before shipping only', () => {
    assert.ok(canTransition('awaiting_payment', 'cancelled'));
    assert.ok(canTransition('paid', 'cancelled'));
    assert.ok(!canTransition('shipped', 'cancelled'));
    assert.ok(!canTransition('delivered', 'cancelled'));
  });

  it('refuses skipping steps and leaving terminal states', () => {
    assert.throws(() => applyTransition(makeOrder(), 'shipped', LATER), InvalidTransitionError);
    assert.throws(() => applyTransition(makeOrder({ status: 'delivered' }), 'paid', LATER), InvalidTransitionError);
    assert.throws(() => applyTransition(makeOrder({ status: 'cancelled' }), 'paid', LATER), InvalidTransitionError);
  });

  it('InvalidTransitionError says which move was refused', () => {
    try {
      applyTransition(makeOrder(), 'delivered', LATER);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof InvalidTransitionError);
      assert.equal(err.from, 'awaiting_payment');
      assert.equal(err.to, 'delivered');
    }
  });

  it('isOrderStatus accepts only real statuses', () => {
    for (const s of ALL_STATUSES) assert.ok(isOrderStatus(s));
    assert.ok(!isOrderStatus('refunded'));
    assert.ok(!isOrderStatus(undefined));
  });
});
