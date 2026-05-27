import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

const PORT = Number.parseInt(process.env.PORT || '8787', 10);
const MERCADOPAGO_API_BASE = (process.env.MERCADOPAGO_API_BASE || 'https://api.mercadopago.com').replace(/\/+$/, '');
const MERCADOPAGO_ACCESS_TOKEN = (process.env.MERCADOPAGO_ACCESS_TOKEN || process.env.PAGBANK_TOKEN || '').trim();
const PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL || `http://localhost:${PORT}`;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PREMIUM_DURATION_DAYS = Number.parseInt(process.env.PREMIUM_DURATION_DAYS || '30', 10);
const PREMIUM_PRICE_BRL = Number.parseFloat(process.env.PREMIUM_PRICE_BRL || '9.99');
const CHECKOUT_RETURN_URL = process.env.CHECKOUT_RETURN_URL || 'https://example.com';

const app = express();

function resolveAllowedOrigins() {
  if (ALLOWED_ORIGIN === '*') return true;
  const origins = ALLOWED_ORIGIN.split(',').map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0) return true;
  return origins;
}

function resolvePublicApiBaseUrl(req) {
  if (PUBLIC_API_BASE_URL && !/localhost|127\.0\.0\.1/i.test(PUBLIC_API_BASE_URL)) {
    return PUBLIC_API_BASE_URL.replace(/\/+$/, '');
  }

  const forwardedHost = req?.headers?.['x-forwarded-host'];
  const host = forwardedHost || req?.headers?.host;
  const forwardedProto = req?.headers?.['x-forwarded-proto'];
  const protocol = (forwardedProto || req?.protocol || 'https').split(',')[0].trim();

  if (host) {
    return `${protocol}://${host}`.replace(/\/+$/, '');
  }

  return PUBLIC_API_BASE_URL.replace(/\/+$/, '');
}

app.use(cors({
  origin: resolveAllowedOrigins(),
  credentials: false,
}));
app.use(express.json({ limit: '1mb' }));

let firestore = null;
const hasFirebaseConfig = Boolean(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY,
);

if (hasFirebaseConfig) {
  try {
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });

    firestore = admin.firestore();
  } catch (err) {
    console.warn('[payments-server] Firebase Admin invalido. Webhook nao ativara premium automaticamente ate corrigir FIREBASE_PRIVATE_KEY/FIREBASE_CLIENT_EMAIL.');
    console.warn(`[payments-server] detalhe: ${err?.message || err}`);
    firestore = null;
  }
} else {
  console.warn('[payments-server] Firebase Admin nao configurado. O webhook nao conseguira ativar premium automaticamente.');
}

function ensurePagBankToken() {
  if (!MERCADOPAGO_ACCESS_TOKEN) {
    const err = new Error('MERCADOPAGO_ACCESS_TOKEN nao configurado no servidor de pagamentos.');
    err.statusCode = 500;
    throw err;
  }
}

function isPagBankNotFoundError(error) {
  const messages = Array.isArray(error?.details?.error_messages) ? error.details.error_messages : [];
  return messages.some((item) => String(item?.code || '').toUpperCase() === 'NOT_FOUND');
}

async function pagBankRequest(path, { method = 'GET', body } = {}) {
  ensurePagBankToken();

  const response = await fetch(`${MERCADOPAGO_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'x-idempotency-key': crypto.randomUUID(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(data.message || data.error || `Falha Mercado Pago (${response.status})`);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

function extractUidFromReference(referenceId) {
  if (!referenceId) return null;
  const match = String(referenceId).match(/^tiotv-premium-([A-Za-z0-9_-]+)-\d+$/);
  return match ? match[1] : null;
}

const PAID_STATUSES = new Set(['PAID', 'AUTHORIZED', 'COMPLETED']);

function getNormalizedPaymentStatus(orderData) {
  const firstCharge = Array.isArray(orderData?.charges) ? orderData.charges[0] : null;
  const chargeStatus = firstCharge?.status || orderData?.status || '';
  const normalized = String(chargeStatus).toUpperCase().trim();
  return normalized || 'PENDING';
}

function findPaymentUrl(order) {
  if (!order || typeof order !== 'object') return null;

  const links = Array.isArray(order.links) ? order.links : [];
  const payLink = links.find((link) => link?.rel === 'PAY' || link?.rel === 'payment');
  if (payLink?.href) return payLink.href;

  const charges = Array.isArray(order.charges) ? order.charges : [];
  for (const charge of charges) {
    const chargeLinks = Array.isArray(charge?.links) ? charge.links : [];
    const chargePayLink = chargeLinks.find((link) => link?.rel === 'PAY' || link?.rel === 'payment');
    if (chargePayLink?.href) return chargePayLink.href;
  }

  const qrCodes = Array.isArray(order.qr_codes) ? order.qr_codes : [];
  for (const qrCode of qrCodes) {
    const qrLinks = Array.isArray(qrCode?.links) ? qrCode.links : [];
    const qrPayLink = qrLinks.find((link) => link?.rel === 'PAY' || link?.rel === 'payment');
    if (qrPayLink?.href) return qrPayLink.href;
  }

  return null;
}

function extractPixCode(order) {
  const qrCodes = Array.isArray(order?.qr_codes) ? order.qr_codes : [];
  const firstQrCode = qrCodes[0];
  const text = firstQrCode?.text;
  if (!text || typeof text !== 'string') return null;
  return text.trim() || null;
}

function extractPixPaymentData(payment) {
  const codeCandidates = [
    payment?.point_of_interaction?.transaction_data?.qr_code,
    payment?.point_of_interaction?.transaction_data?.qr_code_text,
    payment?.transaction_details?.qr_code,
    payment?.qr_code,
  ];

  const base64Candidates = [
    payment?.point_of_interaction?.transaction_data?.qr_code_base64,
    payment?.point_of_interaction?.transaction_data?.qr_code_img,
    payment?.transaction_details?.qr_code_base64,
  ];

  const ticketUrlCandidates = [
    payment?.point_of_interaction?.transaction_data?.ticket_url,
    payment?.transaction_details?.ticket_url,
    payment?.ticket_url,
  ];

  const pixCode = codeCandidates.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim() || null;
  const pixQrCodeBase64 = base64Candidates.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim() || null;
  const pixTicketUrl = ticketUrlCandidates.find((candidate) => typeof candidate === 'string' && candidate.trim())?.trim() || null;

  return {
    pixCode,
    pixQrCodeBase64,
    pixTicketUrl,
  };
}

function getCheckoutPayLink(checkout) {
  const links = Array.isArray(checkout?.links) ? checkout.links : [];
  const payLink = links.find((link) => String(link?.rel || '').toUpperCase() === 'PAY');
  return payLink?.href || null;
}

function getMercadoPagoPreferenceUrl(preference) {
  if (!preference || typeof preference !== 'object') return null;
  const isTestToken = MERCADOPAGO_ACCESS_TOKEN.startsWith('TEST-');
  if (isTestToken) {
    return preference.sandbox_init_point || preference.init_point || null;
  }
  return preference.init_point || preference.sandbox_init_point || null;
}

function getMercadoPagoPaymentStatus(payment) {
  return String(payment?.status || 'pending').toUpperCase();
}

function isMercadoPagoPaidStatus(status) {
  return new Set(['APPROVED', 'AUTHORIZED']).has(String(status || '').toUpperCase());
}

function getValueByPath(source, path) {
  if (!source || typeof source !== 'object') return undefined;
  const keys = String(path || '').split('.').filter(Boolean);
  let current = source;

  for (const key of keys) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

function pickFirstExistingPath(source, candidates = []) {
  for (const path of candidates) {
    const value = getValueByPath(source, path);
    if (value !== undefined) {
      return { path, value };
    }
  }
  return { path: null, value: undefined };
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
}

function sanitizePagBankCustomerName(rawName) {
  const source = String(rawName || '');

  // Remove os caracteres explicitamente bloqueados pelo PagBank.
  const cleaned = source
    .replace(/[!@#$%¨*()"”\\|{}\[\]<>;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return 'Cliente TioTV';
  }

  // Mantem nome em um tamanho razoavel para gateways de pagamento.
  return cleaned.slice(0, 80);
}

function isPublicWebhookUrl(url) {
  if (!url) return false;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return false;
    }
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function activatePremiumByUid(uid, metadata = {}) {
  if (!firestore) {
    throw new Error('Firebase Admin nao configurado no servidor de pagamentos.');
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PREMIUM_DURATION_DAYS * 24 * 60 * 60 * 1000);

  await firestore.collection('Users').doc(uid).set({
    isPremium: true,
    premiumActivatedAt: admin.firestore.Timestamp.fromDate(now),
    premiumExpiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    paymentProvider: metadata.paymentProvider || 'mercadopago',
    paymentStatus: 'PAID',
    paymentUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...metadata,
  }, { merge: true });
}

app.get('/health', (_req, res) => {
  res.json({
    success: true,
    provider: 'mercadopago',
    firebaseReady: Boolean(firestore),
  });
});

app.get('/api/payments/mercadopago/account-status', async (_req, res) => {
  try {
    const account = await pagBankRequest('/users/me');

    const billingAllowCandidate = pickFirstExistingPath(account, [
      'billing.allow',
      'billing_info.allow',
      'billingInfo.allow',
      'billing.allowed',
      'billing_info.allowed',
    ]);

    const confirmedEmailCandidate = pickFirstExistingPath(account, [
      'confirmed_email',
      'email_confirmed',
      'email_verified',
      'status.confirmed_email',
      'status.email_verified',
    ]);

    const billingAllow = normalizeBoolean(billingAllowCandidate.value);
    const confirmedEmail = normalizeBoolean(confirmedEmailCandidate.value);
    const readyForCheckout = billingAllow === true && confirmedEmail === true;

    const checklist = [
      {
        item: 'Abrir painel do Mercado Pago com a mesma conta do access token',
        done: true,
      },
      {
        item: 'Confirmar email da conta (confirmed_email=true)',
        done: confirmedEmail === true,
      },
      {
        item: 'Finalizar cadastro/faturamento para liberar cobrancas (billing.allow=true)',
        done: billingAllow === true,
      },
      {
        item: 'Retestar endpoint /api/payments/pagbank/checkout',
        done: false,
      },
    ];

    return res.json({
      success: true,
      provider: 'mercadopago',
      readyForCheckout,
      checks: {
        billingAllow: {
          value: billingAllow,
          raw: billingAllowCandidate.value,
          sourcePath: billingAllowCandidate.path,
        },
        confirmedEmail: {
          value: confirmedEmail,
          raw: confirmedEmailCandidate.value,
          sourcePath: confirmedEmailCandidate.path,
        },
      },
      accountSummary: {
        id: account?.id || null,
        nickname: account?.nickname || null,
        email: account?.email || null,
        countryId: account?.country_id || null,
        siteId: account?.site_id || null,
      },
      checklist,
      notes: [
        'Se algum campo vier null, o Mercado Pago pode ter mudado o schema da resposta /users/me para sua conta.',
        'Nesse caso, valide os status direto no painel e tente checkout novamente.',
      ],
    });
  } catch (error) {
    console.error('[mercadopago-account-status]', error?.details || error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Falha ao consultar status da conta Mercado Pago.',
      details: error.details || null,
    });
  }
});

app.post('/api/payments/pagbank/checkout', async (req, res) => {
  try {
    const { uid, email, name, taxId } = req.body || {};

    if (!uid || !email || !taxId) {
      return res.status(400).json({
        success: false,
        error: 'uid, email e taxId sao obrigatorios para criar checkout.',
      });
    }

    const sanitizedTaxId = String(taxId).replace(/\D/g, '');
    if (sanitizedTaxId.length !== 11 && sanitizedTaxId.length !== 14) {
      return res.status(400).json({
        success: false,
        error: 'taxId invalido. Informe CPF (11) ou CNPJ (14).',
      });
    }

    const now = Date.now();
    const referenceId = `tiotv-premium-${uid}-${now}`;
    const webhookUrl = `${resolvePublicApiBaseUrl(req)}/api/payments/pagbank/webhook`;
    const hasPublicWebhookUrl = isPublicWebhookUrl(webhookUrl);

    const safeCustomerName = sanitizePagBankCustomerName(name || email?.split('@')[0] || 'Cliente TioTV');

    const identificationType = sanitizedTaxId.length === 14 ? 'CNPJ' : 'CPF';

    const preferencePayload = {
      external_reference: referenceId,
      payer: {
        name: safeCustomerName,
        email,
        identification: {
          type: identificationType,
          number: sanitizedTaxId,
        },
      },
      items: [
        {
          id: 'plan-premium-30d',
          title: 'TioTV Premium',
          quantity: 1,
          currency_id: 'BRL',
          unit_price: PREMIUM_PRICE_BRL,
        },
      ],
      back_urls: {
        success: CHECKOUT_RETURN_URL,
        pending: CHECKOUT_RETURN_URL,
        failure: CHECKOUT_RETURN_URL,
      },
      auto_return: 'approved',
    };

    if (hasPublicWebhookUrl) {
      preferencePayload.notification_url = webhookUrl;
    }

    const preference = await pagBankRequest('/checkout/preferences', {
      method: 'POST',
      body: preferencePayload,
    });

    const paymentUrl = getMercadoPagoPreferenceUrl(preference);

    if (!paymentUrl) {
      return res.status(502).json({
        success: false,
        error: 'Checkout criado sem URL de pagamento retornada pelo Mercado Pago.',
        referenceId,
        preference,
      });
    }

    return res.json({
      success: true,
      paymentUrl,
      pixCode: null,
      referenceId,
      orderId: preference?.id,
    });
  } catch (error) {
    console.error('[pagbank-checkout]', error?.details || error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Erro ao criar checkout Mercado Pago.',
      details: error.details || null,
    });
  }
});

app.post('/api/payments/pagbank/card-checkout', async (req, res) => {
  try {
    const { uid, email, name, taxId } = req.body || {};

    if (!uid || !email || !taxId) {
      return res.status(400).json({
        success: false,
        error: 'uid, email e taxId sao obrigatorios para criar checkout de cartao.',
      });
    }

    const sanitizedTaxId = String(taxId).replace(/\D/g, '');
    if (sanitizedTaxId.length !== 11 && sanitizedTaxId.length !== 14) {
      return res.status(400).json({
        success: false,
        error: 'taxId invalido. Informe CPF (11) ou CNPJ (14).',
      });
    }

    const now = Date.now();
    const referenceId = `tiotv-premium-${uid}-${now}`;
    const webhookUrl = `${resolvePublicApiBaseUrl(req)}/api/payments/pagbank/webhook`;
    const hasPublicWebhookUrl = isPublicWebhookUrl(webhookUrl);
    const safeCustomerName = sanitizePagBankCustomerName(name || email?.split('@')[0] || 'Cliente TioTV');
    const identificationType = sanitizedTaxId.length === 14 ? 'CNPJ' : 'CPF';

    const preferencePayload = {
      external_reference: referenceId,
      payer: {
        name: safeCustomerName,
        email,
        identification: {
          type: identificationType,
          number: sanitizedTaxId,
        },
      },
      items: [
        {
          id: 'plan-premium-30d',
          title: 'TioTV Premium',
          quantity: 1,
          currency_id: 'BRL',
          unit_price: PREMIUM_PRICE_BRL,
        },
      ],
      payment_methods: {
        excluded_payment_types: [
          { id: 'ticket' },
          { id: 'bank_transfer' },
          { id: 'atm' },
        ],
      },
      back_urls: {
        success: CHECKOUT_RETURN_URL,
        pending: CHECKOUT_RETURN_URL,
        failure: CHECKOUT_RETURN_URL,
      },
      auto_return: 'approved',
      redirect_url: CHECKOUT_RETURN_URL,
      return_url: CHECKOUT_RETURN_URL,
    };

    if (hasPublicWebhookUrl) {
      preferencePayload.notification_url = webhookUrl;
    }

    const preference = await pagBankRequest('/checkout/preferences', {
      method: 'POST',
      body: preferencePayload,
    });

    const paymentUrl = getMercadoPagoPreferenceUrl(preference);
    if (!paymentUrl) {
      return res.status(502).json({
        success: false,
        error: 'Checkout web criado sem link de pagamento.',
        referenceId,
        preference,
      });
    }

    return res.json({
      success: true,
      paymentUrl,
      referenceId,
      checkoutId: preference?.id,
      checkoutStatus: 'ACTIVE',
    });
  } catch (error) {
    console.error('[pagbank-card-checkout]', error?.details || error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Erro ao criar checkout de cartao no Mercado Pago.',
      details: error.details || null,
    });
  }
});

app.post('/api/payments/mercadopago/pix-checkout', async (req, res) => {
  try {
    const { uid, email, name, taxId } = req.body || {};

    if (!uid || !email || !taxId) {
      return res.status(400).json({
        success: false,
        error: 'uid, email e taxId sao obrigatorios para criar checkout PIX.',
      });
    }

    const sanitizedTaxId = String(taxId).replace(/\D/g, '');
    if (sanitizedTaxId.length !== 11 && sanitizedTaxId.length !== 14) {
      return res.status(400).json({
        success: false,
        error: 'taxId invalido. Informe CPF (11) ou CNPJ (14).',
      });
    }

    const now = Date.now();
    const referenceId = `tiotv-premium-${uid}-${now}`;
    const webhookUrl = `${resolvePublicApiBaseUrl(req)}/api/payments/pagbank/webhook`;
    const hasPublicWebhookUrl = isPublicWebhookUrl(webhookUrl);
    const safeCustomerName = sanitizePagBankCustomerName(name || email?.split('@')[0] || 'Cliente TioTV');

    const pixPaymentPayload = {
      transaction_amount: PREMIUM_PRICE_BRL,
      description: 'TioTV Premium',
      payment_method_id: 'pix',
      external_reference: referenceId,
      payer: {
        email,
        first_name: safeCustomerName.split(' ')[0] || 'Cliente',
        last_name: safeCustomerName.split(' ').slice(1).join(' ') || 'TioTV',
        identification: {
          type: sanitizedTaxId.length === 14 ? 'CNPJ' : 'CPF',
          number: sanitizedTaxId,
        },
      },
    };

    if (hasPublicWebhookUrl) {
      pixPaymentPayload.notification_url = webhookUrl;
    }

    const payment = await pagBankRequest('/v1/payments', {
      method: 'POST',
      body: pixPaymentPayload,
    });

    const pixData = extractPixPaymentData(payment);
    const pixCode = pixData.pixCode || extractPixCode(payment) || null;

    if (!pixCode) {
      return res.status(502).json({
        success: false,
        error: 'Pagamento PIX criado sem codigo PIX retornado pelo Mercado Pago.',
        referenceId,
        payment,
      });
    }

    return res.json({
      success: true,
      pixCode,
      pixQrCodeBase64: pixData.pixQrCodeBase64,
      pixTicketUrl: pixData.pixTicketUrl,
      referenceId,
      paymentId: payment?.id ? String(payment.id) : null,
      status: getMercadoPagoPaymentStatus(payment),
    });
  } catch (error) {
    console.error('[mercadopago-pix-checkout]', error?.details || error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Erro ao criar pagamento PIX no Mercado Pago.',
      details: error.details || null,
    });
  }
});

app.post('/api/payments/pagbank/verify', async (req, res) => {
  try {
    const { uid, orderId, checkoutId, referenceId } = req.body || {};

    if (!uid || (!orderId && !checkoutId)) {
      return res.status(400).json({
        success: false,
        error: 'uid e orderId (ou checkoutId) sao obrigatorios para verificar pagamento.',
      });
    }

    const resolvedReferenceId = referenceId || null;

    if (!resolvedReferenceId) {
      return res.status(400).json({
        success: false,
        error: 'referenceId e obrigatorio para verificar pagamento no Mercado Pago.',
      });
    }

    const uidFromReference = extractUidFromReference(resolvedReferenceId);

    if (uidFromReference && uidFromReference !== uid) {
      return res.status(403).json({
        success: false,
        error: 'Pagamento nao pertence ao usuario informado.',
      });
    }

    const searchQuery = `/v1/payments/search?external_reference=${encodeURIComponent(resolvedReferenceId)}&sort=date_created&criteria=desc&limit=1`;
    const paymentSearch = await pagBankRequest(searchQuery);
    const payments = Array.isArray(paymentSearch?.results) ? paymentSearch.results : [];
    const latestPayment = payments[0] || null;

    const normalizedStatus = getMercadoPagoPaymentStatus(latestPayment);
    const paid = isMercadoPagoPaidStatus(normalizedStatus);
    const resolvedOrderId = latestPayment?.id ? String(latestPayment.id) : (orderId || null);

    if (paid) {
      await activatePremiumByUid(uid, {
        paymentReference: resolvedReferenceId,
        paymentOrderId: resolvedOrderId || null,
        paymentCheckoutId: checkoutId || (orderId || null),
        paymentProvider: 'mercadopago',
      });
    }

    return res.json({
      success: true,
      paid,
      status: normalizedStatus,
      referenceId: resolvedReferenceId,
      orderId: resolvedOrderId || null,
      checkoutId: checkoutId || null,
    });
  } catch (error) {
    console.error('[pagbank-verify]', error?.details || error);
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Falha ao verificar pagamento no PagBank.',
      details: error.details || null,
    });
  }
});

app.post('/api/payments/pagbank/webhook', async (req, res) => {
  try {
    const webhookPaymentId = req.body?.data?.id || req.query?.['data.id'] || req.body?.id || null;
    let paymentData = null;

    if (webhookPaymentId) {
      try {
        paymentData = await pagBankRequest(`/v1/payments/${webhookPaymentId}`);
      } catch (fetchErr) {
        console.error('[mercadopago-webhook-fetch-payment]', fetchErr?.details || fetchErr);
      }
    }

    const referenceId = paymentData?.external_reference || req.body?.external_reference || null;
    const uid = extractUidFromReference(referenceId);
    const normalizedStatus = getMercadoPagoPaymentStatus(paymentData);

    if (uid && isMercadoPagoPaidStatus(normalizedStatus)) {
      await activatePremiumByUid(uid, {
        paymentReference: referenceId,
        paymentOrderId: paymentData?.id ? String(paymentData.id) : null,
        paymentProvider: 'mercadopago',
      });
      console.log(`[pagbank-webhook] Premium ativado para uid=${uid}`);
    } else {
      console.log('[pagbank-webhook] Evento recebido sem ativacao', {
        referenceId,
        uid,
        status: normalizedStatus,
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('[pagbank-webhook]', error);
    return res.status(500).json({ success: false, error: 'Falha ao processar webhook.' });
  }
});

export default app;

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`[payments-server] online em http://localhost:${PORT}`);
  });
}
