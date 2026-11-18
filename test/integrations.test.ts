import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { buildPaymentUrl, parseItn, phpUrlEncode, sign, verifyItnSignature } from '../src/lib/payfast.ts';
import { parseWebhook, verifySignature } from '../src/lib/whatsapp.ts';
import { makeOrder } from './helpers.ts';

describe('PayFast', () => {
  it('url-encodes like PHP', () => {
    assert.equal(phpUrlEncode('John Doe'), 'John+Doe');
    assert.equal(phpUrlEncode("it's (50%) *free*!"), 'it%27s+%2850%25%29+%2Afree%2A%21');
    assert.equal(phpUrlEncode('a@b.co.za'), 'a%40b.co.za');
  });

  const cfg = {
    merchantId: '10000100',
    merchantKey: '46f0cd694581a',
    passphrase: 'jt7NOE43FZPn',
    sandbox: true,
    notifyUrl: 'https://example.lambda-url.af-south-1.on.aws/',
  };

  it('builds a signed sandbox payment link that carries the order number and amount', () => {
    const url = new URL(buildPaymentUrl(makeOrder(), cfg));
    assert.equal(url.host, 'sandbox.payfast.co.za');
    assert.equal(url.searchParams.get('m_payment_id'), '1001');
    assert.equal(url.searchParams.get('amount'), '500.00');
    assert.equal(url.searchParams.get('item_name'), 'Order #1001');
    assert.equal(url.searchParams.get('name_first'), 'Thandi');
    assert.equal(url.searchParams.get('name_last'), 'Nkosi');
    assert.match(url.searchParams.get('signature') ?? '', /^[0-9a-f]{32}$/);
  });

  it('omits empty optional fields (return/cancel urls) from the link', () => {
    const url = new URL(buildPaymentUrl(makeOrder(), cfg));
    assert.equal(url.searchParams.has('return_url'), false);
  });

  it('signature in the link matches an independent recomputation', () => {
    const link = buildPaymentUrl(makeOrder(), cfg);
    const query = link.split('?')[1]!;
    const withoutSig = query.replace(/&signature=[0-9a-f]+$/, '');
    const fields = withoutSig.split('&').map((pair) => {
      const [k, v] = pair.split('=') as [string, string];
      return [k, decodeURIComponent(v.replace(/\+/g, ' '))] as const;
    });
    assert.equal(sign(fields, cfg.passphrase), link.match(/signature=([0-9a-f]+)$/)![1]);
  });

  function itnBody(passphrase: string, overrides: Record<string, string> = {}): string {
    const fields: [string, string][] = Object.entries({
      m_payment_id: '1001',
      pf_payment_id: '1089250',
      payment_status: 'COMPLETE',
      item_name: 'Order #1001',
      amount_gross: '500.00',
      amount_fee: '-11.50',
      amount_net: '488.50',
      name_first: 'Thandi',
      ...overrides,
    });
    const signature = sign(fields, passphrase);
    return new URLSearchParams([...fields, ['signature', signature]]).toString();
  }

  it('accepts an ITN with a correct signature', () => {
    assert.ok(verifyItnSignature(itnBody('secret'), 'secret'));
  });
  it('rejects a wrong passphrase, a missing signature and tampered values', () => {
    assert.ok(!verifyItnSignature(itnBody('secret'), 'other'));
    assert.ok(!verifyItnSignature('m_payment_id=1001&amount_gross=500.00', 'secret'));
    assert.ok(!verifyItnSignature(itnBody('secret').replace('500.00', '5.00'), 'secret'));
  });
  it('works without a passphrase', () => {
    assert.ok(verifyItnSignature(itnBody(''), ''));
  });
  it('parses the fields the webhook needs', () => {
    assert.deepEqual(parseItn(itnBody('secret')), {
      orderNumber: 1001,
      paymentStatus: 'COMPLETE',
      amountGrossCents: 50000,
      pfPaymentId: '1089250',
    });
    assert.equal(parseItn('foo=bar'), undefined);
  });
});

describe('WhatsApp webhook helpers', () => {
  const secret = 'app-secret';
  const body = JSON.stringify({ hello: 'world' });
  const goodHeader = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('verifies Meta signatures', () => {
    assert.ok(verifySignature(body, goodHeader, secret));
    assert.ok(!verifySignature(body + ' ', goodHeader, secret));
    assert.ok(!verifySignature(body, goodHeader, 'wrong-secret'));
    assert.ok(!verifySignature(body, undefined, secret));
    assert.ok(!verifySignature(body, 'sha256=zzzz', secret));
    assert.ok(!verifySignature(body, 'sha256=', secret));
  });

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: '27821234567', profile: { name: 'Thandi Nkosi' } }],
              messages: [
                { id: 'wamid.1', from: '27821234567', type: 'text', text: { body: 'Hi' } },
                { id: 'wamid.2', from: '27821234567', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'order', title: 'Place an order' } } },
                { id: 'wamid.3', from: '27821234567', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'p:ORIG-500', title: 'Original biltong 500g' } } },
                { id: 'wamid.4', from: '27821234567', type: 'image' },
              ],
              statuses: [{ id: 'wamid.x', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }, { id: 'wamid.y', status: 'delivered' }],
            },
          },
        ],
      },
    ],
  };

  it('parses text, button, list and unsupported messages with the profile name', () => {
    const parsed = parseWebhook(JSON.stringify(payload));
    assert.deepEqual(
      parsed.messages.map((m) => [m.id, m.kind, m.replyId ?? m.text ?? null, m.name]),
      [
        ['wamid.1', 'text', 'Hi', 'Thandi Nkosi'],
        ['wamid.2', 'button', 'order', 'Thandi Nkosi'],
        ['wamid.3', 'list', 'p:ORIG-500', 'Thandi Nkosi'],
        ['wamid.4', 'other', null, 'Thandi Nkosi'],
      ],
    );
  });

  it('surfaces failed delivery statuses only', () => {
    const parsed = parseWebhook(JSON.stringify(payload));
    assert.deepEqual(parsed.failedStatuses, [{ id: 'wamid.x', code: 131047, title: 'Re-engagement message' }]);
  });

  it('survives garbage and empty payloads', () => {
    assert.deepEqual(parseWebhook('not json'), { messages: [], failedStatuses: [] });
    assert.deepEqual(parseWebhook('{}'), { messages: [], failedStatuses: [] });
  });
});
