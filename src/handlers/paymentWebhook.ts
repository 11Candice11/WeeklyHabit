import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import * as db from '../lib/db.ts';
import { config } from '../lib/config.ts';
import { markPaid } from '../lib/orderService.ts';
import { parseItn, validateItnWithPayFast, verifyItnSignature } from '../lib/payfast.ts';

// PayFast ITN (Instant Transaction Notification) endpoint.
// Never trust the body alone. Before marking an order paid we check:
//   1. the signature matches (shared passphrase)
//   2. PayFast confirms it sent this notification (server-to-server validate call)
//   3. the order exists and the amount paid matches the order total
//   4. payment_status is COMPLETE

function rawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const body = rawBody(event);

  if (!verifyItnSignature(body, config.payfast.passphrase())) {
    console.warn('PayFast ITN rejected: bad signature');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  const itn = parseItn(body);
  if (!itn) return { statusCode: 400, body: 'Malformed notification' };

  if (!(await validateItnWithPayFast(body, config.payfast.sandbox()))) {
    console.warn('PayFast ITN rejected: validation failed', { orderNumber: itn.orderNumber });
    return { statusCode: 400, body: 'Validation failed' };
  }

  const order = await db.getOrder(itn.orderNumber);
  if (!order) {
    console.warn('PayFast ITN for an unknown order', { orderNumber: itn.orderNumber });
    return { statusCode: 200, body: 'ok' }; // acknowledge so PayFast stops retrying
  }

  if (itn.amountGrossCents !== order.totalCents) {
    console.error('PayFast ITN amount mismatch', { orderNumber: order.orderNumber, paid: itn.amountGrossCents, expected: order.totalCents });
    return { statusCode: 200, body: 'ok' };
  }

  if (itn.paymentStatus === 'COMPLETE') {
    await markPaid(order.orderNumber, itn.pfPaymentId, new Date().toISOString());
  } else {
    console.info('PayFast ITN with non-complete status', { orderNumber: order.orderNumber, status: itn.paymentStatus });
  }

  return { statusCode: 200, body: 'ok' };
}
