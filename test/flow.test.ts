import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleMessage } from '../src/lib/flow.ts';
import type { Customer, IncomingMessage, OutgoingAction, Session } from '../src/lib/types.ts';
import { NOW, tap, text } from './helpers.ts';

/** Drive the flow through a list of messages, returning the final session and every action produced. */
function run(messages: IncomingMessage[], customer?: Customer) {
  let session: Session | undefined;
  const all: OutgoingAction[][] = [];
  for (const msg of messages) {
    const result = handleMessage(session, msg, customer, NOW);
    session = result.session;
    all.push(result.actions);
  }
  return { session: session!, all, last: all[all.length - 1]! };
}

const bodyOf = (a: OutgoingAction | undefined) => (a && 'body' in a ? a.body : '');

describe('conversation flow', () => {
  it('greets with the welcome buttons', () => {
    const { last } = run([text('hi')]);
    assert.equal(last[0]?.type, 'buttons');
  });

  it('shows the product list after "Place an order"', () => {
    const { session, last } = run([text('hi'), tap('order')]);
    assert.equal(session.step, 'choosing_product');
    assert.equal(last[0]?.type, 'list');
  });

  it('completes the full order journey for a new customer', () => {
    const { session, all } = run([
      text('hi'),
      tap('order'),
      tap('p:ORIG-500'),
      text('2'),
      tap('checkout'),
      text('12 Protea Road, Sea Point, Cape Town, 8005'),
      tap('confirm'),
    ]);

    const final = all[all.length - 1]!;
    assert.equal(final.length, 1);
    const action = final[0]!;
    assert.equal(action.type, 'create_order');
    if (action.type !== 'create_order') return;
    assert.deepEqual(action.cart, [{ sku: 'ORIG-500', qty: 2 }]);
    assert.equal(action.address, '12 Protea Road, Sea Point, Cape Town, 8005');
    assert.equal(action.name, 'Thandi Nkosi');

    // The session is cleared once the order is handed off.
    assert.equal(session.step, 'idle');
    assert.deepEqual(session.cart, []);
  });

  it('merges repeat additions of the same product', () => {
    const { session } = run([tap('order'), tap('p:ORIG-250'), text('1'), tap('add_more'), tap('p:ORIG-250'), text('2')]);
    assert.deepEqual(session.cart, [{ sku: 'ORIG-250', qty: 3 }]);
  });

  it('can add a second product', () => {
    const { session } = run([tap('order'), tap('p:ORIG-250'), text('1'), tap('add_more'), tap('p:DROE-500'), text('1')]);
    assert.equal(session.cart.length, 2);
  });

  it('shows the total with delivery in the cart summary', () => {
    const { last } = run([tap('order'), tap('p:ORIG-250'), text('1')]);
    const body = bodyOf(last[0]);
    assert.match(body, /1 x Original biltong 250g - R110/);
    assert.match(body, /Delivery: R80/);
    assert.match(body, /\*Total: R190\*/);
  });

  it('rejects bad quantities and stays on the quantity step', () => {
    for (const bad of ['0', '21', 'lots', '-1', '2.5']) {
      const { session, last } = run([tap('order'), tap('p:ORIG-250'), text(bad)]);
      assert.equal(session.step, 'entering_qty', `"${bad}" should be rejected`);
      assert.match(bodyOf(last[0]), /whole number/);
    }
  });

  it('rejects too-short addresses', () => {
    const { session } = run([tap('order'), tap('p:ORIG-250'), text('1'), tap('checkout'), text('home')]);
    assert.equal(session.step, 'entering_address');
  });

  it('offers a saved address to returning customers', () => {
    const customer: Customer = { waId: '27821234567', name: 'Thandi Nkosi', address: '12 Protea Road, Cape Town, 8005' };
    const { session, last } = run([tap('order'), tap('p:ORIG-250'), text('1'), tap('checkout')], customer);
    assert.equal(session.step, 'address_choice');
    assert.match(bodyOf(last[0]), /12 Protea Road/);

    const used = run([tap('order'), tap('p:ORIG-250'), text('1'), tap('checkout'), tap('use_addr'), tap('confirm')], customer);
    assert.equal(used.last[0]?.type, 'create_order');
  });

  it('lets the customer change the address at the confirmation step', () => {
    const { session } = run([
      tap('order'),
      tap('p:ORIG-250'),
      text('1'),
      tap('checkout'),
      text('12 Protea Road, Sea Point, Cape Town, 8005'),
      tap('new_addr'),
    ]);
    assert.equal(session.step, 'entering_address');
    assert.equal(session.address, undefined);
  });

  it('"cancel" clears the cart from any step', () => {
    const { session, last } = run([tap('order'), tap('p:ORIG-250'), text('1'), text('cancel')]);
    assert.equal(session.step, 'idle');
    assert.deepEqual(session.cart, []);
    assert.match(bodyOf(last[0]), /cleared/);
  });

  it('cannot create an order from an empty cart', () => {
    const { last } = run([tap('order'), tap('confirm')]);
    assert.ok(last.every((a) => a.type !== 'create_order'));
  });

  it('answers the "My last order" button with an order_status action', () => {
    const { last } = run([text('hi'), tap('status')]);
    assert.equal(last[0]?.type, 'order_status');
  });

  it('handles images / voice notes politely', () => {
    const other: IncomingMessage = { id: 'x', from: '27821234567', kind: 'other' };
    const { last } = run([other]);
    assert.match(bodyOf(last[0]), /only read text/);
  });

  it('re-asks the current question when the customer types something unexpected', () => {
    const { session, last } = run([tap('order'), tap('p:ORIG-250'), text('1'), text('what time do you close?')]);
    assert.equal(session.step, 'cart');
    assert.equal(last[0]?.type, 'buttons');
  });
});
