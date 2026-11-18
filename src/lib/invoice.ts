import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { formatRand } from './catalog.ts';
import { localDay } from './time.ts';
import type { Order } from './types.ts';

export interface BusinessDetails {
  name: string;
  contact: string;
  address: string;
  bankDetails: string;
}

// pdf-lib's built-in fonts only cover WinAnsi (basic Latin + Latin-1). Anything else
// (emoji, some accented customer names) would throw, so replace it rather than fail the order.
// Emoji and other astral-plane characters are dropped; other unsupported characters become "?".
function safe(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xffff) continue;
    out += (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) ? ch : '?';
  }
  return out.trim();
}

const INK = rgb(0.15, 0.15, 0.15);
const MUTED = rgb(0.45, 0.45, 0.45);
const BRAND = rgb(0.48, 0.18, 0.12);
const GREEN = rgb(0.18, 0.5, 0.25);

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/).map(safe)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const attempt = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(attempt, size) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = attempt;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Generate a one-page A4 invoice. The same layout is used for the unpaid invoice and the paid receipt. */
export async function generateInvoicePdf(order: Order, business: BusinessDetails): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Invoice INV-${order.orderNumber}`);
  pdf.setProducer('Biltong orders');
  const page: PDFPage = pdf.addPage([595.28, 841.89]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const left = 50;
  const right = 545;
  let y = 790;

  const text = (s: string, x: number, yy: number, opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {}) =>
    page.drawText(safe(s), { x, y: yy, font: opts.font ?? regular, size: opts.size ?? 10, color: opts.color ?? INK });
  const rightText = (s: string, yy: number, opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> } = {}) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? 10;
    text(s, right - font.widthOfTextAtSize(safe(s), size), yy, opts);
  };

  // Header
  text(business.name, left, y, { font: bold, size: 20, color: BRAND });
  rightText('INVOICE', y, { font: bold, size: 20 });
  y -= 18;
  for (const line of [business.address, business.contact].filter(Boolean)) {
    for (const l of wrap(line, regular, 9, 280)) {
      text(l, left, y, { size: 9, color: MUTED });
      y -= 12;
    }
  }
  rightText(`INV-${order.orderNumber}`, 772, { font: bold, size: 11 });
  rightText(`Date: ${localDay(order.createdAt)}`, 758, { size: 9, color: MUTED });
  rightText(`Order #${order.orderNumber}`, 746, { size: 9, color: MUTED });

  // Bill to
  y = Math.min(y, 730) - 24;
  text('BILL TO', left, y, { font: bold, size: 8, color: MUTED });
  y -= 14;
  text(order.customerName, left, y, { font: bold, size: 11 });
  y -= 14;
  for (const l of wrap(order.address, regular, 10, 260)) {
    text(l, left, y);
    y -= 13;
  }
  text(`WhatsApp: +${order.customerWaId}`, left, y, { size: 9, color: MUTED });
  y -= 34;

  // Items table
  const colQty = 330;
  const colUnit = 430;
  page.drawRectangle({ x: left, y: y - 6, width: right - left, height: 22, color: rgb(0.96, 0.94, 0.9) });
  text('Item', left + 8, y, { font: bold, size: 9 });
  text('Qty', colQty, y, { font: bold, size: 9 });
  text('Unit price', colUnit - 20, y, { font: bold, size: 9 });
  rightText('Amount', y, { font: bold, size: 9 });
  y -= 26;
  for (const item of order.items) {
    text(item.name, left + 8, y);
    text(String(item.qty), colQty, y);
    text(formatRand(item.unitPriceCents), colUnit - 20, y);
    rightText(formatRand(item.qty * item.unitPriceCents), y);
    y -= 20;
  }
  page.drawLine({ start: { x: left, y: y + 8 }, end: { x: right, y: y + 8 }, thickness: 0.5, color: MUTED });

  // Totals
  y -= 10;
  text('Subtotal', 400, y);
  rightText(formatRand(order.subtotalCents), y);
  y -= 16;
  text('Delivery', 400, y);
  rightText(order.deliveryCents ? formatRand(order.deliveryCents) : 'Free', y);
  y -= 22;
  text('TOTAL', 400, y, { font: bold, size: 12 });
  rightText(formatRand(order.totalCents), y, { font: bold, size: 12 });
  y -= 36;

  // Payment status
  const paid = order.status === 'paid' || order.status === 'shipped' || order.status === 'delivered';
  if (paid) {
    text('PAID', left, y, { font: bold, size: 18, color: GREEN });
    if (order.paidAt) text(`Received ${localDay(order.paidAt)}`, left + 60, y + 2, { size: 9, color: MUTED });
    y -= 30;
  } else if (order.status === 'cancelled') {
    text('CANCELLED', left, y, { font: bold, size: 18, color: MUTED });
    y -= 30;
  } else {
    text('Payment due', left, y, { font: bold, size: 11 });
    y -= 14;
    text('Please pay using the secure payment link we sent on WhatsApp.', left, y, { size: 9, color: MUTED });
    y -= 14;
    if (business.bankDetails) {
      text('Or pay by EFT:', left, y, { size: 9, color: MUTED });
      y -= 12;
      for (const l of wrap(business.bankDetails.replace(/\s*\|\s*/g, '\n'), regular, 9, 400)) {
        text(l, left, y, { size: 9 });
        y -= 12;
      }
      text(`Use reference: INV-${order.orderNumber}`, left, y, { font: bold, size: 9 });
      y -= 12;
    }
  }

  text('Thank you for your order!', left, 60, { size: 10, color: MUTED });
  return pdf.save();
}
