# Shopify Giveaway Generator

Embedded Shopify app for exporting customers who have a value in a chosen customer metafield, with a built-in preview and CSV download flow.

The default target field is `custom.tcg_interest`, which matches the customer data you described for giveaways.

## What it does

- Installs as a Shopify embedded app using offline OAuth
- Stores the offline session locally in SQLite or in Railway Postgres
- Scans all customers through the Admin GraphQL API in 250-customer pages
- Filters to customers whose selected metafield has a non-empty value
- Shows a preview, a simple interest summary, and a CSV export download

## Stack

- Node 20+
- Express
- `@shopify/shopify-api`
- SQLite for local sessions, PostgreSQL on Railway if `DATABASE_URL` is set

## Shopify app setup

Create the app in Shopify Partner Dashboard or in the store admin developer-app flow, then set:

- App URL: `https://your-domain.example.com/app`
- Allowed redirection URL: `https://your-domain.example.com/auth/callback`
- Admin API scope: `read_customers`

Then copy the API key and secret into your environment.

## Environment variables

Copy `.env.example` to `.env` and fill in:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `APP_URL`
- `NODE_ENV`
- `DATABASE_URL` optional on Railway

## Local development

```bash
git clone https://github.com/pandorasdeckbox/shopify-giveaway-generator.git
cd shopify-giveaway-generator
npm install
cp .env.example .env
npm run tunnel
```

Put the Cloudflare URL into `APP_URL`, then run:

```bash
npm run dev
```

Install the app by visiting:

```text
https://your-app-url.example.com/auth?shop=pandorasdeckbox.myshopify.com
```

Then open it in Shopify admin or directly at:

```text
https://your-app-url.example.com/app?shop=pandorasdeckbox.myshopify.com
```

## Railway deployment

1. Push the repo to GitHub.
2. Create a Railway project from the repo.
3. Add a PostgreSQL service if you want persistent sessions across deploys.
4. Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `APP_URL`, and `NODE_ENV=production`.
5. Add your custom domain if desired.

## API endpoints

- `GET /health`
- `GET /auth`
- `GET /auth/callback`
- `GET /api/report?shop=...&namespace=custom&key=tcg_interest`
- `GET /api/export/customers.csv?shop=...&namespace=custom&key=tcg_interest`

## CSV output

The export columns are:

- `first_name`
- `last_name`
- `email`
- `tcg_interest`

If your customers store multiple interests in one metafield, the raw CSV keeps the original value, while the on-screen summary splits on commas, semicolons, pipes, and line breaks.
