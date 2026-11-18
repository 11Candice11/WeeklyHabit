import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { config } from './config.ts';
import { localMonth } from './time.ts';
import type { Customer, Order, OrderStatus, Session } from './types.ts';

// Single-table design (table name in TABLE_NAME):
//
//   pk                 sk     what
//   ORDER#<number>     META   an order        gsi1 = MONTH#<yyyy-mm>   gsi2 = STATUS#<status>
//   SESSION#<waId>     META   conversation state (ttl 24h)
//   CUSTOMER#<waId>    META   saved name / address / last order number
//   MSG#<messageId>    META   WhatsApp message de-duplication marker (ttl 7d)
//   COUNTER#order      META   atomic order number counter
//
// gsi1 answers "all orders in a month" (dashboard, history). gsi2 answers "all orders in a status" (active orders).

let client: DynamoDBDocumentClient | undefined;
function ddb(): DynamoDBDocumentClient {
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return client;
}

const SESSION_TTL_SECONDS = 24 * 60 * 60;
const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;
const FIRST_ORDER_NUMBER = 1001;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ----------------------------------------------------------------- orders

type OrderItemRecord = Order & { pk: string; sk: string; gsi1pk: string; gsi1sk: string; gsi2pk: string; gsi2sk: string };

function orderKeys(order: Order) {
  const suffix = `${order.createdAt}#${order.orderNumber}`;
  return {
    pk: `ORDER#${order.orderNumber}`,
    sk: 'META',
    gsi1pk: `MONTH#${localMonth(order.createdAt)}`,
    gsi1sk: suffix,
    gsi2pk: `STATUS#${order.status}`,
    gsi2sk: suffix,
  };
}

function stripKeys(item: Record<string, unknown>): Order {
  const { pk: _pk, sk: _sk, gsi1pk: _g1p, gsi1sk: _g1s, gsi2pk: _g2p, gsi2sk: _g2s, ttl: _ttl, ...order } = item;
  return order as unknown as Order;
}

export async function nextOrderNumber(): Promise<number> {
  const res = await ddb().send(
    new UpdateCommand({
      TableName: config.tableName(),
      Key: { pk: 'COUNTER#order', sk: 'META' },
      UpdateExpression: 'SET #n = if_not_exists(#n, :start) + :one',
      ExpressionAttributeNames: { '#n': 'value' },
      ExpressionAttributeValues: { ':start': FIRST_ORDER_NUMBER - 1, ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return Number(res.Attributes?.value);
}

export async function createOrder(order: Order): Promise<void> {
  const item: OrderItemRecord = { ...order, ...orderKeys(order) };
  await ddb().send(
    new PutCommand({
      TableName: config.tableName(),
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk)',
    }),
  );
}

export async function getOrder(orderNumber: number): Promise<Order | undefined> {
  const res = await ddb().send(
    new GetCommand({ TableName: config.tableName(), Key: { pk: `ORDER#${orderNumber}`, sk: 'META' } }),
  );
  return res.Item ? stripKeys(res.Item) : undefined;
}

export class StaleOrderError extends Error {
  constructor(orderNumber: number) {
    super(`Order ${orderNumber} was changed by someone else - reload and try again`);
    this.name = 'StaleOrderError';
  }
}

/**
 * Save an updated order, but only if it is still in `expectedStatus` in the database.
 * Stops the admin app and the PayFast webhook overwriting each other.
 */
export async function saveOrder(order: Order, expectedStatus: OrderStatus): Promise<void> {
  const item: OrderItemRecord = { ...order, ...orderKeys(order) };
  try {
    await ddb().send(
      new PutCommand({
        TableName: config.tableName(),
        Item: item,
        ConditionExpression: '#status = :expected',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':expected': expectedStatus },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') throw new StaleOrderError(order.orderNumber);
    throw err;
  }
}

async function queryIndex(index: 'gsi1' | 'gsi2', pk: string): Promise<Order[]> {
  const out: Order[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb().send(
      new QueryCommand({
        TableName: config.tableName(),
        IndexName: index,
        KeyConditionExpression: `${index}pk = :pk`,
        ExpressionAttributeValues: { ':pk': pk },
        ScanIndexForward: false, // newest first
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) out.push(stripKeys(item));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return out;
}

export function listOrdersByMonth(month: string): Promise<Order[]> {
  return queryIndex('gsi1', `MONTH#${month}`);
}

export function listOrdersByStatus(status: OrderStatus): Promise<Order[]> {
  return queryIndex('gsi2', `STATUS#${status}`);
}

// --------------------------------------------------------------- sessions

export async function getSession(waId: string): Promise<Session | undefined> {
  const res = await ddb().send(new GetCommand({ TableName: config.tableName(), Key: { pk: `SESSION#${waId}`, sk: 'META' } }));
  if (!res.Item) return undefined;
  const { pk: _pk, sk: _sk, ttl: _ttl, ...session } = res.Item;
  return session as unknown as Session;
}

export async function putSession(session: Session): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: config.tableName(),
      Item: { ...session, pk: `SESSION#${session.waId}`, sk: 'META', ttl: nowSeconds() + SESSION_TTL_SECONDS },
    }),
  );
}

// --------------------------------------------------------------- customers

export async function getCustomer(waId: string): Promise<Customer | undefined> {
  const res = await ddb().send(new GetCommand({ TableName: config.tableName(), Key: { pk: `CUSTOMER#${waId}`, sk: 'META' } }));
  if (!res.Item) return undefined;
  const { pk: _pk, sk: _sk, ...customer } = res.Item;
  return customer as unknown as Customer;
}

export async function putCustomer(customer: Customer): Promise<void> {
  await ddb().send(
    new PutCommand({ TableName: config.tableName(), Item: { ...customer, pk: `CUSTOMER#${customer.waId}`, sk: 'META' } }),
  );
}

// ------------------------------------------------------------ de-duplication

/** Returns true the first time a WhatsApp message id is seen, false for a retry / duplicate. */
export async function claimMessage(messageId: string): Promise<boolean> {
  try {
    await ddb().send(
      new PutCommand({
        TableName: config.tableName(),
        Item: { pk: `MSG#${messageId}`, sk: 'META', ttl: nowSeconds() + DEDUPE_TTL_SECONDS },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

/** Undo a claim so a failed message can be retried by SQS. */
export async function releaseMessage(messageId: string): Promise<void> {
  await ddb().send(new DeleteCommand({ TableName: config.tableName(), Key: { pk: `MSG#${messageId}`, sk: 'META' } }));
}
