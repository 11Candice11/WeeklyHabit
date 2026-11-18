import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateInvoicePdf } from '../src/lib/invoice.ts';
import { makeOrder } from './helpers.ts';

const business = {
  name: 'Droëwors & Co Biltong',
  contact: '082 555 0123 | orders@example.co.za',
  address: '14 Voortrekker Street, Paarl, 7646',
  bankDetails: 'FNB | Account name: Droewors and Co | Acc no: 6200 0000 000',
};

const isPdf = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';

describe('generateInvoicePdf', () => {
  it('produces a PDF for an unpaid order', async () => {
    assert.ok(isPdf(await generateInvoicePdf(makeOrder(), business)));
  });

  it('produces a PDF for paid and cancelled orders', async () => {
    assert.ok(isPdf(await generateInvoicePdf(makeOrder({ status: 'paid', paidAt: '2026-11-17T12:00:00.000Z' }), business)));
    assert.ok(isPdf(await generateInvoicePdf(makeOrder({ status: 'cancelled' }), business)));
  });

  it('does not fail on emoji, non-Latin-1 characters or newlines in customer text', async () => {
    const order = makeOrder({
      customerName: 'Thandi 🙂 Nkosi ł',
      address: '12 Protea Road\nSea Point 🌊\nCape Town, 8005',
    });
    assert.ok(isPdf(await generateInvoicePdf(order, business)));
  });

  it('does not fail with no business contact, address or bank details', async () => {
    assert.ok(isPdf(await generateInvoicePdf(makeOrder(), { name: 'Shop', contact: '', address: '', bankDetails: '' })));
  });
});
