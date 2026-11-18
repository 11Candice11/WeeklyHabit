import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { handleMessage } from '../lib/flow.ts';
import * as db from '../lib/db.ts';
import { placeOrder } from '../lib/orderService.ts';
import { statusLabel } from '../lib/orders.ts';
import { formatRand } from '../lib/catalog.ts';
import { parseWebhook, sendFlowAction, sendText } from '../lib/whatsapp.ts';
import type { IncomingMessage } from '../lib/types.ts';

// Takes queued WhatsApp webhooks off SQS and runs the order conversation.
// A message that throws is released from the de-duplication table and retried by SQS (then the dead-letter queue).

async function processMessage(msg: IncomingMessage): Promise<void> {
  const now = new Date().toISOString();
  const [session, customer] = await Promise.all([db.getSession(msg.from), db.getCustomer(msg.from)]);
  const result = handleMessage(session, msg, customer, now);

  // Creating an order is the one step that must not run twice, so persist the (already cleared)
  // session first. Every other step saves the session after replying, so a failed send is retried cleanly.
  const createsOrder = result.actions.some((a) => a.type === 'create_order');
  if (createsOrder) await db.putSession(result.session);

  for (const action of result.actions) {
    switch (action.type) {
      case 'create_order':
        await placeOrder(msg.from, action, now);
        break;
      case 'order_status': {
        const last = customer?.lastOrderNumber ? await db.getOrder(customer.lastOrderNumber) : undefined;
        await sendText(
          msg.from,
          last
            ? `Order #${last.orderNumber}: ${statusLabel(last.status)} (${formatRand(last.totalCents)}).`
            : "You don't have any orders with us yet. Tap *Place an order* to get started.",
        );
        break;
      }
      default:
        await sendFlowAction(msg.from, action);
    }
  }

  if (!createsOrder) await db.putSession(result.session);
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    const { messages, failedStatuses } = parseWebhook(record.body);

    for (const failed of failedStatuses) {
      // e.g. 131047 = tried to message outside the 24h window. Worth seeing in the logs.
      console.warn('WhatsApp reported a failed delivery', failed);
    }

    try {
      for (const msg of messages) {
        if (!(await db.claimMessage(msg.id))) continue; // duplicate delivery
        try {
          await processMessage(msg);
        } catch (err) {
          await db.releaseMessage(msg.id).catch(() => undefined);
          throw err;
        }
      }
    } catch (err) {
      console.error('Failed to process queued webhook', { messageId: record.messageId, err });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
