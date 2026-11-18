// All money is stored as integer cents (ZAR) to avoid floating point errors.

export type OrderStatus = 'awaiting_payment' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
}

export interface Order {
  orderNumber: number;
  customerWaId: string; // WhatsApp ID, e.g. "27821234567"
  customerName: string;
  address: string;
  items: OrderItem[];
  subtotalCents: number;
  deliveryCents: number;
  totalCents: number;
  status: OrderStatus;
  createdAt: string; // ISO 8601, UTC
  updatedAt: string;
  paidAt?: string;
  shippedAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  paymentRef?: string;
  invoiceKey?: string; // S3 key of the latest invoice PDF
}

export interface CartLine {
  sku: string;
  qty: number;
}

export type FlowStep =
  | 'idle'
  | 'choosing_product'
  | 'entering_qty'
  | 'cart'
  | 'address_choice'
  | 'entering_address'
  | 'confirming';

export interface Session {
  waId: string;
  step: FlowStep;
  cart: CartLine[];
  pendingSku?: string;
  address?: string;
  name?: string;
  updatedAt: string;
}

export interface Customer {
  waId: string;
  name: string;
  address?: string;
  lastOrderNumber?: number;
}

export interface IncomingMessage {
  id: string;
  from: string; // wa_id
  name?: string; // WhatsApp profile name
  kind: 'text' | 'button' | 'list' | 'other';
  text?: string;
  replyId?: string; // id of the tapped button / list row
}

export interface ButtonDef {
  id: string;
  title: string; // max 20 chars (WhatsApp limit)
}

export interface ListRow {
  id: string;
  title: string; // max 24 chars
  description?: string; // max 72 chars
}

export interface CreateOrderAction {
  type: 'create_order';
  cart: CartLine[];
  address: string;
  name: string;
}

export type OutgoingAction =
  | { type: 'text'; body: string }
  | { type: 'buttons'; body: string; buttons: ButtonDef[] }
  | { type: 'list'; body: string; buttonText: string; rows: ListRow[] }
  | { type: 'order_status' }
  | CreateOrderAction;
