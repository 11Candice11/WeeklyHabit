import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.ts';

let s3: S3Client | undefined;
function client(): S3Client {
  s3 ??= new S3Client({});
  return s3;
}

export function invoiceKey(orderNumber: number): string {
  return `invoices/INV-${orderNumber}.pdf`;
}

export async function putInvoice(key: string, pdf: Uint8Array): Promise<void> {
  await client().send(
    new PutObjectCommand({ Bucket: config.invoiceBucket(), Key: key, Body: pdf, ContentType: 'application/pdf' }),
  );
}

/** A short-lived link the admin site can open to view / download the PDF. */
export function invoiceDownloadUrl(key: string, filename: string): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: config.invoiceBucket(),
      Key: key,
      ResponseContentType: 'application/pdf',
      ResponseContentDisposition: `inline; filename="${filename}"`,
    }),
    { expiresIn: 15 * 60 },
  );
}
