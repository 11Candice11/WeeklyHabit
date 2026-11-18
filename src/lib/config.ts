// Configuration is read lazily from environment variables (set in template.yaml),
// so importing this file never throws and unit tests can run without any env.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  tableName: () => required('TABLE_NAME'),
  queueUrl: () => required('QUEUE_URL'),
  invoiceBucket: () => required('INVOICE_BUCKET'),

  wa: {
    token: () => required('WA_TOKEN'),
    appSecret: () => required('WA_APP_SECRET'),
    verifyToken: () => required('WA_VERIFY_TOKEN'),
    phoneNumberId: () => required('WA_PHONE_NUMBER_ID'),
    apiVersion: () => optional('WA_API_VERSION', 'v22.0'),
    orderUpdateTemplate: () => optional('WA_ORDER_UPDATE_TEMPLATE'),
  },

  payfast: {
    merchantId: () => required('PAYFAST_MERCHANT_ID'),
    merchantKey: () => required('PAYFAST_MERCHANT_KEY'),
    passphrase: () => optional('PAYFAST_PASSPHRASE'),
    sandbox: () => optional('PAYFAST_SANDBOX', 'true') !== 'false',
    notifyUrl: () => required('PAYFAST_NOTIFY_URL'),
    returnUrl: () => optional('PAYFAST_RETURN_URL'),
    cancelUrl: () => optional('PAYFAST_CANCEL_URL'),
  },

  business: {
    name: () => optional('BUSINESS_NAME', 'Biltong Shop'),
    contact: () => optional('BUSINESS_CONTACT'),
    address: () => optional('BUSINESS_ADDRESS'),
    bankDetails: () => optional('BANK_DETAILS'),
  },

  admin: {
    userPoolId: () => required('COGNITO_USER_POOL_ID'),
    clientId: () => required('COGNITO_CLIENT_ID'),
  },
};
