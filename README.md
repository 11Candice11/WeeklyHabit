# Biltong orders

WhatsApp ordering, invoicing and an admin API for a small biltong shop. Runs on AWS and is designed to stay inside the always-free tier at a few hundred orders a month.

```
Customer ──WhatsApp──> Meta Cloud API ──webhook──> whatsappWebhook (Lambda URL)
                                                         │ verify signature, queue, return 200
                                                         ▼
                                                     SQS queue ──> worker (Lambda)
                                                                     │ conversation flow, create order
                              PayFast ──ITN──> paymentWebhook        │ invoice PDF -> S3, send on WhatsApp
                                  (verify, mark paid, send receipt)  ▼
                                                                  DynamoDB   S3 (invoices)
Admin website ──Cognito JWT──> adminApi (Lambda URL) ─────────────────┘
```

| Piece | What it does |
| --- | --- |
| `src/handlers/whatsappWebhook.ts` | Meta handshake + signature check, drops payloads on SQS, answers 200 immediately |
| `src/handlers/worker.ts` | Runs the order conversation, creates orders, sends invoice + payment link |
| `src/handlers/paymentWebhook.ts` | PayFast ITN: checks signature, confirms with PayFast, checks the amount, marks paid, sends receipt |
| `src/handlers/adminApi.ts` | JSON API for the admin site (stats, orders, history, status changes, resend, CSV export) |
| `src/lib/flow.ts` | The WhatsApp conversation as a pure function (fully unit tested) |
| `src/lib/orders.ts` | Order state machine: awaiting payment → paid → shipped → delivered, or cancelled |
| `src/lib/catalog.ts` | **Products, prices and delivery fee - edit this first** |

## 1. Before you deploy

1. **Products and prices**: edit `src/lib/catalog.ts`. The ones in there are placeholders. Max 10 products (WhatsApp list limit).
2. **Business name and contact** for the invoice: set as stack parameters (below).
3. **VAT**: invoices here are plain invoices. If the shop is VAT registered, South African rules need a tax invoice with a VAT number and VAT breakdown. Check with the owner's accountant and extend `src/lib/invoice.ts`.
4. **Meta / WhatsApp**:
   - Create an app at developers.facebook.com (type: Business) and add the WhatsApp product.
   - Create a **System User** in Business Settings, give it the app, and generate a **permanent access token** with `whatsapp_business_messaging` and `whatsapp_business_management`. (The temporary token in the dashboard expires in 24 hours.)
   - Note the **Phone number ID** (not the phone number) and the **App secret** (App settings → Basic).
   - Start with Meta's free test number and add your own phone as a recipient. Move to the shop's real number when it all works.
5. **PayFast**: create a sandbox account at sandbox.payfast.co.za. Use its merchant ID, merchant key and set a passphrase in Settings → Integration. Switch to live credentials and `PayFastSandbox=false` when ready.
6. **Order-update template** (optional but recommended): WhatsApp only allows free-form messages within 24 hours of the customer's last message. For "your order has shipped" days later, create a **utility** template in WhatsApp Manager with two body variables, for example `Update on order #{{1}}: {{2}}`, and pass its name as `OrderUpdateTemplate`. Without it, late notifications fail (the admin API tells you when that happens).

## 2. Deploy

Needs Node 22, AWS SAM CLI and AWS credentials.

```bash
npm install
npm test                 # 58 unit tests, no AWS account needed
npm run typecheck
sam build
sam deploy --guided      # stack name e.g. biltong-orders; region af-south-1 is opt-in, eu-west-1 is fine too
```

`--guided` prompts for each parameter (secrets are hidden). Answer **yes** to "save arguments to samconfig.toml" - that file is git-ignored.

After deploy, the stack outputs give you three URLs.

### Connect WhatsApp

1. Meta dashboard → WhatsApp → Configuration → **Callback URL** = `WhatsAppWebhookUrl`, **Verify token** = the `WhatsAppVerifyToken` you chose. Click Verify.
2. Subscribe to the **messages** webhook field.
3. Message the test number "hi" from your phone.

### Create the admin login

Self sign-up is off. Create the shop owner's user:

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username owner@example.com \
  --user-attributes Name=email,Value=owner@example.com Name=email_verified,Value=true
```

She gets a temporary password by email. The admin website signs in with Cognito (SRP, using the `UserPoolClientId`) and sends the **access token** as `Authorization: Bearer <token>`. In production set `AdminSiteOrigin` to the site's URL so CORS is locked down.

### PayFast notify URL

Payment links already carry the notify URL of `paymentWebhook`, nothing to configure in the PayFast dashboard.

## 3. Admin API

All routes need `Authorization: Bearer <Cognito access token>`.

| Route | Purpose |
| --- | --- |
| `GET /stats?month=2026-11` | Dashboard: revenue, orders, average order, awaiting payment, orders per day, top products |
| `GET /orders` | Active orders (awaiting payment, paid, shipped), newest first |
| `GET /orders?month=2026-11&q=thandi&status=paid` | History for a month, with search and status filter |
| `GET /orders/1042` | One order, plus `allowedNextStatuses` for drawing the right buttons |
| `POST /orders/1042/status` `{"status":"shipped","notify":true}` | Move an order on and message the customer |
| `POST /orders/1042/resend-invoice` | Send the invoice PDF again |
| `POST /orders/1042/resend-payment-link` | Send the payment link again (also returns the URL) |
| `GET /orders/1042/invoice` | `{ "url": ... }` 15 minute link to the PDF |
| `GET /export?month=2026-11` | CSV of the month's orders |

Money is in **cents** everywhere in the API. Months are SAST calendar months.

## 4. Data model

One DynamoDB table (provisioned 5/5 capacity, plus two indexes, 15 units total against the 25 always-free):

| pk | what |
| --- | --- |
| `ORDER#1042` | an order. `gsi1` = by month, `gsi2` = by status |
| `SESSION#<waId>` | conversation state, expires after 24h |
| `CUSTOMER#<waId>` | saved name, address, last order |
| `MSG#<id>` | de-duplication marker for WhatsApp retries, expires after 7 days |
| `COUNTER#order` | order number counter (first order is #1001) |

## 5. Costs and free tier

- **Lambda, SQS, DynamoDB, Cognito, S3**: well inside always-free allowances at this volume. AWS changed free-tier rules for accounts created after mid-2025 (a credits-based plan for the first months), so **set a budget alert (e.g. R50/month) on day one**.
- **Lambda Function URLs** are used instead of API Gateway, so there is no API Gateway bill.
- **WhatsApp**: Meta charges per message by category. Replies inside the 24h window after the customer messages are free; templates and some outbound messages cost. Check Meta's current rate card.
- **PayFast** takes a fee per transaction.
- Secrets are stored as Lambda environment variables (encrypted at rest) to avoid the monthly cost of Secrets Manager. If you want them out of the Lambda console, move them to SSM Parameter Store.

## 6. Things to know

- **Duplicates**: Meta retries webhooks. Each message ID is claimed in DynamoDB before it is processed, so retries are ignored.
- **Races**: every order save is conditional on the status the code read, so the admin app and the PayFast webhook cannot silently overwrite each other (a stale save returns HTTP 409).
- **Failed sends never lose an order**: if the invoice or payment link cannot be sent, the order still exists and the admin can use "resend".
- **Dead-letter queue**: messages that fail 3 times land in `MessageDeadLetterQueue`. Look there if a customer says the bot ignored them.

## Troubleshooting

- **Function URL returns 403 `Forbidden` right after deploy**: AWS tightened Function URL permissions in late 2025. Add a resource policy allowing public invoke, for example:
  `aws lambda add-permission --function-name <fn> --statement-id FunctionURLAllowPublicAccess --action lambda:InvokeFunction --principal '*' --invoked-via-function-url`
  (do this for the WhatsApp webhook, PayFast webhook and admin API functions).
- **Webhook verification fails in Meta**: the verify token must match exactly; check CloudWatch logs for `whatsappWebhook`.
- **Messages arrive but nothing replies**: check the worker's CloudWatch logs and the dead-letter queue. A wrong `WhatsAppToken` or `WhatsAppPhoneNumberId` is the usual cause.
- **WhatsApp error 131047** when notifying: more than 24 hours since the customer wrote and no template configured, see step 6 under "Before you deploy".
