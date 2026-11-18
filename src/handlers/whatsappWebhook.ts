import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { config } from '../lib/config.ts';
import { verifySignature } from '../lib/whatsapp.ts';

// Receives WhatsApp webhooks. Does the minimum - verify, queue, answer 200 - because Meta
// retries slow or failed deliveries. The real work happens in worker.ts.

const sqs = new SQSClient({});

function rawBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;

  // Meta's one-off subscription handshake (GET with hub.* query parameters).
  if (method === 'GET') {
    const q = event.queryStringParameters ?? {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.wa.verifyToken() && q['hub.challenge']) {
      return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: q['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }

  if (method !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const body = rawBody(event);
  const signature = event.headers['x-hub-signature-256'];
  if (!verifySignature(body, signature, config.wa.appSecret())) {
    console.warn('Rejected webhook with a bad signature');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  await sqs.send(new SendMessageCommand({ QueueUrl: config.queueUrl(), MessageBody: body }));
  return { statusCode: 200, body: 'ok' };
}
