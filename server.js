import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';
import dotenv from 'dotenv';
import { ApiVersion, LogSeverity, Session, shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';

import { initDatabase, sessionStorage } from './database.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REQUIRED_ENV = ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'APP_URL'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

await initDatabase();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const oauthStateStorage = new Map();
const DEFAULT_NAMESPACE = 'custom';
const DEFAULT_KEY = 'tcg_interest';
const CUSTOMER_PAGE_SIZE = 250;

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_customers'],
  hostName: process.env.APP_URL.replace(/^https?:\/\//, ''),
  hostScheme: 'https',
  apiVersion: ApiVersion.January25,
  isEmbeddedApp: true,
  sessionStorage,
  logger: {
    level: IS_PRODUCTION ? LogSeverity.Warning : LogSeverity.Debug,
  },
  useOnlineTokens: false,
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', async (req, res) => {
  const { shop, host } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

  const session = await sessionStorage.loadSession(`offline_${sanitizedShop}`);
  if (!session) {
    const authUrl = `/auth?shop=${encodeURIComponent(sanitizedShop)}${host ? `&host=${encodeURIComponent(String(host))}` : ''}`;
    return res.send(renderTopRedirect(authUrl));
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', async (req, res) => {
  const { shop, host } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

  const session = await sessionStorage.loadSession(`offline_${sanitizedShop}`);
  if (!session) {
    const authUrl = `/auth?shop=${encodeURIComponent(sanitizedShop)}${host ? `&host=${encodeURIComponent(String(host))}` : ''}`;
    return res.send(renderTopRedirect(authUrl));
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/exitiframe', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send('Missing shop parameter');

  const sanitizedShop = shopify.utils.sanitizeShop(shop);
  if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

  const redirectUri = `https://${sanitizedShop}/admin/apps/${process.env.SHOPIFY_API_KEY}/auth?shop=${encodeURIComponent(sanitizedShop)}`;
  res.send(renderTopRedirect(redirectUri));
});

app.get('/auth', async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) return res.status(400).send('Missing shop parameter');

    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    if (!sanitizedShop) return res.status(400).send('Invalid shop parameter');

    const state = crypto.randomBytes(16).toString('hex');
    oauthStateStorage.set(sanitizedShop, state);

    const authUrl = `https://${sanitizedShop}/admin/oauth/authorize?` + new URLSearchParams({
      client_id: process.env.SHOPIFY_API_KEY,
      scope: 'read_customers',
      redirect_uri: `${process.env.APP_URL}/auth/callback`,
      state,
    }).toString();

    res.redirect(authUrl);
  } catch (error) {
    res.status(500).send(`Authentication failed: ${error.message}`);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code, state } = req.query;
    if (!shop || !code || !state) throw new Error('Missing required OAuth parameters');

    const sanitizedShop = shopify.utils.sanitizeShop(shop, true);
    if (!sanitizedShop) throw new Error('Invalid shop parameter');

    const storedState = oauthStateStorage.get(sanitizedShop);
    if (storedState !== state) throw new Error('Invalid OAuth state parameter');
    oauthStateStorage.delete(sanitizedShop);

    const tokenResponse = await fetch(`https://${sanitizedShop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
    }

    const { access_token: accessToken, scope } = await tokenResponse.json();
    const sessionId = `offline_${sanitizedShop}`;
    await sessionStorage.deleteSession(sessionId);

    const session = new Session({
      id: sessionId,
      shop: sanitizedShop,
      state,
      isOnline: false,
      scope,
      accessToken,
    });

    await sessionStorage.storeSession(session);
    res.redirect(`https://${sanitizedShop}/admin/apps/${process.env.SHOPIFY_API_KEY}`);
  } catch (error) {
    res.status(500).send(`Authentication callback failed: ${error.message}`);
  }
});

app.get('/api/shop', withSession(async (req, res) => {
  res.json({ shop: req.shopifySession.shop });
}));

app.get('/api/report', withSession(async (req, res) => {
  const namespace = normalizeNamespace(req.query.namespace);
  const key = normalizeKey(req.query.key);
  const report = await buildCustomerInterestReport(req.shopifySession, { namespace, key });
  res.json(report);
}));

app.get('/api/export/customers.csv', withSession(async (req, res) => {
  const namespace = normalizeNamespace(req.query.namespace);
  const key = normalizeKey(req.query.key);
  const report = await buildCustomerInterestReport(req.shopifySession, { namespace, key });
  const safeKey = `${namespace}_${key}`.replace(/[^a-zA-Z0-9_-]+/g, '_');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeKey}_customers.csv"`);
  res.send(toCsv(report.rows));
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Unexpected server error' });
});

app.listen(PORT, () => {
  console.log(`Shopify giveaway generator listening on port ${PORT}`);
});

function renderTopRedirect(url) {
  return `<!DOCTYPE html><html><head><script>window.top.location.href=${JSON.stringify(url)};<\/script></head><body>Redirecting...</body></html>`;
}

function withSession(handler) {
  return async (req, res, next) => {
    try {
      const rawShop = req.query.shop || req.body?.shop;
      if (!rawShop) {
        return res.status(401).json({ error: 'Missing shop parameter', needsReauth: true });
      }

      const shop = shopify.utils.sanitizeShop(rawShop);
      if (!shop) {
        return res.status(401).json({ error: 'Invalid shop parameter', needsReauth: true });
      }

      const session = await sessionStorage.loadSession(`offline_${shop}`);
      if (!session) {
        return res.status(401).json({
          error: 'No session found',
          needsReauth: true,
          authUrl: `/auth?shop=${encodeURIComponent(shop)}`,
        });
      }

      req.shopifySession = session;
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

function normalizeNamespace(value) {
  const namespace = String(value || DEFAULT_NAMESPACE).trim();
  return namespace || DEFAULT_NAMESPACE;
}

function normalizeKey(value) {
  const key = String(value || DEFAULT_KEY).trim();
  return key || DEFAULT_KEY;
}

async function buildCustomerInterestReport(session, { namespace, key }) {
  const rows = [];
  const summary = new Map();
  let scannedCount = 0;
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const payload = await runCustomerQuery(session, { namespace, key, cursor });
    const customers = payload.data?.customers;

    if (!customers) {
      throw new Error(payload.errors?.[0]?.message || 'Shopify did not return customer data');
    }

    for (const edge of customers.edges) {
      scannedCount += 1;

      const node = edge.node;
      const interestValue = node.metafield?.value?.trim();
      if (!interestValue) {
        continue;
      }

      const row = {
        first_name: node.firstName || '',
        last_name: node.lastName || '',
        email: node.email || '',
        tcg_interest: interestValue,
      };

      rows.push(row);

      const values = splitInterestValues(interestValue);
      if (!values.length) {
        incrementSummary(summary, interestValue);
      } else {
        for (const value of values) {
          incrementSummary(summary, value);
        }
      }
    }

    hasNextPage = Boolean(customers.pageInfo.hasNextPage);
    cursor = customers.pageInfo.endCursor;
  }

  return {
    namespace,
    key,
    scannedCount,
    matchedCount: rows.length,
    rows,
    summary: [...summary.entries()]
      .map(([interest, count]) => ({ interest, count }))
      .sort((left, right) => right.count - left.count || left.interest.localeCompare(right.interest)),
  };
}

async function runCustomerQuery(session, { namespace, key, cursor }) {
  const query = `query CustomerInterests($first: Int!, $after: String, $namespace: String!, $key: String!) {
    customers(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          firstName
          lastName
          email
          metafield(namespace: $namespace, key: $key) {
            value
          }
        }
      }
    }
  }`;

  const response = await fetch(`https://${session.shop}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': session.accessToken,
    },
    body: JSON.stringify({
      query,
      variables: {
        first: CUSTOMER_PAGE_SIZE,
        after: cursor,
        namespace,
        key,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Shopify GraphQL request failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

function splitInterestValues(value) {
  return value
    .split(/[|,;\n]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function incrementSummary(summary, key) {
  summary.set(key, (summary.get(key) || 0) + 1);
}

function toCsv(rows) {
  const headers = ['first_name', 'last_name', 'email', 'tcg_interest'];
  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(headers.map(header => escapeCsvCell(row[header] || '')).join(','));
  }

  return lines.join('\n');
}

function escapeCsvCell(value) {
  const stringValue = String(value ?? '');
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }

  return `"${stringValue.replaceAll('"', '""')}"`;
}
