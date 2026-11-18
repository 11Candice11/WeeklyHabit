import { CATALOG, MAX_QTY_PER_LINE, calcTotals, formatRand, getProduct } from './catalog.ts';
import type { Customer, IncomingMessage, OutgoingAction, Session } from './types.ts';

// The WhatsApp conversation as a pure function: (session, message) -> (new session, replies).
// No I/O in here, so the whole ordering journey is unit-tested without WhatsApp or AWS.
//
//   idle -> choosing_product -> entering_qty -> cart -> (address_choice) -> entering_address -> confirming -> order created
//                  ^                              |
//                  +------------ add more --------+

export interface FlowResult {
  session: Session;
  actions: OutgoingAction[];
}

const GREETINGS = new Set(['hi', 'hello', 'hey', 'hallo', 'howzit', 'start', 'menu', 'order', 'sawubona', 'molo']);
const RESET_WORDS = new Set(['cancel', 'menu', 'stop', 'reset']);

export function newSession(waId: string, now: string): Session {
  return { waId, step: 'idle', cart: [], updatedAt: now };
}

function reset(session: Session, now: string): Session {
  return { waId: session.waId, step: 'idle', cart: [], name: session.name, updatedAt: now };
}

function welcome(): OutgoingAction {
  return {
    type: 'buttons',
    body: 'Welcome! What would you like to do?',
    buttons: [
      { id: 'order', title: 'Place an order' },
      { id: 'status', title: 'My last order' },
    ],
  };
}

function productList(): OutgoingAction {
  return {
    type: 'list',
    body: 'What would you like to order?',
    buttonText: 'See products',
    rows: CATALOG.map((p) => ({
      id: `p:${p.sku}`,
      title: p.name,
      description: `${formatRand(p.priceCents)} - ${p.description}`.slice(0, 72),
    })),
  };
}

function cartSummaryLines(session: Session): string {
  const t = calcTotals(session.cart);
  const lines = t.items.map((i) => `${i.qty} x ${i.name} - ${formatRand(i.qty * i.unitPriceCents)}`);
  lines.push(`Delivery: ${t.deliveryCents ? formatRand(t.deliveryCents) : 'Free'}`);
  lines.push(`*Total: ${formatRand(t.totalCents)}*`);
  return lines.join('\n');
}

function cartPrompt(session: Session): OutgoingAction {
  return {
    type: 'buttons',
    body: `Your order so far:\n${cartSummaryLines(session)}`,
    buttons: [
      { id: 'checkout', title: 'Checkout' },
      { id: 'add_more', title: 'Add more' },
      { id: 'clear', title: 'Start over' },
    ],
  };
}

function confirmPrompt(session: Session): OutgoingAction {
  return {
    type: 'buttons',
    body: `Please check your order:\n${cartSummaryLines(session)}\n\nDeliver to:\n${session.address ?? ''}`,
    buttons: [
      { id: 'confirm', title: 'Confirm order' },
      { id: 'new_addr', title: 'Change address' },
      { id: 'clear', title: 'Cancel' },
    ],
  };
}

/** Re-ask the question for whatever step the customer is on. */
function promptFor(session: Session): OutgoingAction[] {
  switch (session.step) {
    case 'idle':
      return [welcome()];
    case 'choosing_product':
      return [productList()];
    case 'entering_qty': {
      const product = session.pendingSku ? getProduct(session.pendingSku) : undefined;
      return [{ type: 'text', body: `How many ${product?.name ?? 'of those'} would you like? Reply with a number (1-${MAX_QTY_PER_LINE}).` }];
    }
    case 'cart':
      return [cartPrompt(session)];
    case 'address_choice':
      return [addressChoicePrompt(session)];
    case 'entering_address':
      return [{ type: 'text', body: 'What is your full delivery address? Please include street, suburb, city and postal code.' }];
    case 'confirming':
      return [confirmPrompt(session)];
  }
}

function addressChoicePrompt(session: Session): OutgoingAction {
  return {
    type: 'buttons',
    body: `Should we deliver to your saved address?\n${session.address ?? ''}`,
    buttons: [
      { id: 'use_addr', title: 'Yes, use it' },
      { id: 'new_addr', title: 'New address' },
    ],
  };
}

function normalise(msg: IncomingMessage): string {
  return (msg.text ?? '').trim().toLowerCase();
}

export function handleMessage(
  existing: Session | undefined,
  msg: IncomingMessage,
  customer: Customer | undefined,
  now: string,
): FlowResult {
  let session: Session = existing ?? newSession(msg.from, now);
  session = { ...session, updatedAt: now, name: msg.name ?? session.name ?? customer?.name };

  if (msg.kind === 'other') {
    return {
      session,
      actions: [{ type: 'text', body: "Sorry, I can only read text and button taps. Reply *menu* to start again." }, ...promptFor(session)],
    };
  }

  const text = normalise(msg);
  const replyId = msg.replyId;

  // Reset commands work at any point in the conversation.
  if (replyId === 'clear' || (msg.kind === 'text' && RESET_WORDS.has(text))) {
    const cleared = reset(session, now);
    return {
      session: cleared,
      actions: [{ type: 'text', body: 'No problem - your order has been cleared.' }, welcome()],
    };
  }

  // Buttons that can be tapped from the welcome message at any time.
  if (replyId === 'status') {
    return { session: reset(session, now), actions: [{ type: 'order_status' }] };
  }
  if (replyId === 'order') {
    return { session: { ...session, step: 'choosing_product' }, actions: [productList()] };
  }

  switch (session.step) {
    case 'idle': {
      if (GREETINGS.has(text)) return { session, actions: [welcome()] };
      return { session, actions: [{ type: 'text', body: 'Hi there!' }, welcome()] };
    }

    case 'choosing_product': {
      if (replyId?.startsWith('p:')) {
        const product = getProduct(replyId.slice(2));
        if (product) {
          const next: Session = { ...session, step: 'entering_qty', pendingSku: product.sku };
          return { session: next, actions: promptFor(next) };
        }
      }
      return { session, actions: [{ type: 'text', body: "Please pick a product from the list." }, productList()] };
    }

    case 'entering_qty': {
      const qty = parseQty(msg);
      if (qty === undefined || !session.pendingSku) {
        return { session, actions: [{ type: 'text', body: `Please reply with a whole number between 1 and ${MAX_QTY_PER_LINE}.` }] };
      }
      const cart = [...session.cart];
      const existingLine = cart.find((l) => l.sku === session.pendingSku);
      if (existingLine) {
        existingLine.qty = Math.min(MAX_QTY_PER_LINE, existingLine.qty + qty);
      } else {
        cart.push({ sku: session.pendingSku, qty });
      }
      const next: Session = { ...session, step: 'cart', cart, pendingSku: undefined };
      return { session: next, actions: [cartPrompt(next)] };
    }

    case 'cart': {
      if (replyId === 'add_more') {
        return { session: { ...session, step: 'choosing_product' }, actions: [productList()] };
      }
      if (replyId === 'checkout') {
        if (customer?.address) {
          const next: Session = { ...session, step: 'address_choice', address: customer.address };
          return { session: next, actions: [addressChoicePrompt(next)] };
        }
        const next: Session = { ...session, step: 'entering_address' };
        return { session: next, actions: promptFor(next) };
      }
      return { session, actions: promptFor(session) };
    }

    case 'address_choice': {
      if (replyId === 'use_addr') {
        const next: Session = { ...session, step: 'confirming' };
        return { session: next, actions: [confirmPrompt(next)] };
      }
      if (replyId === 'new_addr') {
        const next: Session = { ...session, step: 'entering_address', address: undefined };
        return { session: next, actions: promptFor(next) };
      }
      return { session, actions: promptFor(session) };
    }

    case 'entering_address': {
      const address = (msg.text ?? '').trim();
      if (msg.kind !== 'text' || address.length < 10) {
        return { session, actions: [{ type: 'text', body: 'That looks too short. Please send your full delivery address (street, suburb, city, postal code).' }] };
      }
      const next: Session = { ...session, step: 'confirming', address };
      return { session: next, actions: [confirmPrompt(next)] };
    }

    case 'confirming': {
      if (replyId === 'new_addr') {
        const next: Session = { ...session, step: 'entering_address', address: undefined };
        return { session: next, actions: promptFor(next) };
      }
      if (replyId === 'confirm' && session.cart.length > 0 && session.address) {
        return {
          session: reset(session, now),
          actions: [
            {
              type: 'create_order',
              cart: session.cart,
              address: session.address,
              name: session.name ?? 'Customer',
            },
          ],
        };
      }
      return { session, actions: promptFor(session) };
    }
  }
}

function parseQty(msg: IncomingMessage): number | undefined {
  const match = /^\s*(\d{1,3})\s*(x|pcs|packs?)?\s*$/i.exec(msg.text ?? '');
  if (!match?.[1]) return undefined;
  const qty = Number(match[1]);
  return qty >= 1 && qty <= MAX_QTY_PER_LINE ? qty : undefined;
}
