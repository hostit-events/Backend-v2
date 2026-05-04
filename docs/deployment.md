# HostIT Backend — Deployment Runbook

Step-by-step guide for getting the backend live on Render with Supabase Postgres + Upstash Redis. Targets a **staging environment** (sandbox keys, Base Sepolia) — promoting to production is the same flow with production credentials.

## Cost summary

| Component | Provider | Plan | Cost |
|---|---|---|---|
| Backend hosting | Render | Starter Web Service | $7/mo |
| PostgreSQL | Supabase | Free | $0 |
| Redis | Upstash | Free | $0 |
| DNS / TLS | Cloudflare | Free | $0 |
| **Total** | | | **$7/mo** |

Free Render won't work — it sleeps after 15 min of inactivity, breaking webhooks and cron jobs. Starter is the minimum viable tier.

## One-time setup

### 1. Provider signups

- **Render** — [render.com](https://render.com). Free account.
- **Supabase** — [supabase.com](https://supabase.com). Free account.
- **Upstash** — [upstash.com](https://upstash.com). Free account.
- **Cloudflare** (only if using a custom domain) — [cloudflare.com](https://cloudflare.com). Free account.

### 2. Provision Supabase (Postgres)

1. Create a new project. Pick the region closest to your Render deployment.
2. Set a strong database password (you can't change it without resetting credentials, so save it in a secrets manager).
3. Once the project is up, go to **Project Settings → Database → Connection string**.
4. Copy two URLs:
   - **Transaction Pooler** (port 6543) — append `?pgbouncer=true` → this is your `DATABASE_URL`
   - **Direct connection** (port 5432) → this is your `DIRECT_URL`
5. Both should have your password substituted in (remove the `[YOUR-PASSWORD]` placeholder).

### 3. Provision Upstash (Redis)

1. Create a new Redis database. Region close to Render.
2. Enable **TLS** (required for production).
3. From the database dashboard, copy:
   - **Endpoint** → `REDIS_HOST`
   - **Port** → `REDIS_PORT` (typically 6379 or a custom port)
   - **Password** → `REDIS_PASSWORD`

### 4. Generate production-grade secrets

Run locally:

```bash
# JWT signing secret
openssl rand -hex 32
# → paste as JWT_SECRET in Render

# Ticket QR signing secret
openssl rand -hex 32
# → paste as TICKET_QR_SIGNING_SECRET in Render
```

Both are 64-character hex strings (32 bytes). Store backups in a secrets manager.

### 5. Run Circle bootstrap against the deployed environment

The Circle entity secret is registered **once per Circle account** — sandbox and production are separate Circle environments with separate ceremonies. For staging, you can reuse the same sandbox setup we already have locally; copy the existing values from your local `.env`:

- `CIRCLE_API_KEY`
- `CIRCLE_ENTITY_SECRET`
- `CIRCLE_WALLET_SET_ID`
- `CIRCLE_TREASURY_WALLET_SET_ID`
- `CIRCLE_TREASURY_WALLET_ID`

For **production** (later, when you're cutting over from staging):

1. Create a separate Circle production account at `console.circle.com`
2. Generate a new production API key
3. Run the four bootstrap scripts locally with the production key:
   ```bash
   pnpm circle:generate-secret
   pnpm circle:register-secret
   pnpm circle:bootstrap-wallet-set
   pnpm circle:bootstrap-treasury
   ```
4. **Back up the recovery file at `~/.circle/recovery-file.json` to a secrets manager.** Lose this and the entity secret and every wallet becomes unrecoverable.
5. Use the resulting production IDs in Render's prod env.

### 6. Connect the repo to Render

1. In Render dashboard → **New → Blueprint**.
2. Connect your GitHub account.
3. Select the `backend-v2` repository.
4. Render reads `render.yaml` and proposes the service config.
5. Click **Apply**.

Render creates the `hostit-api-staging` service. The first deploy will fail because env vars haven't been set yet — that's expected.

### 7. Set environment variables in Render

In the service dashboard → **Environment**. Add every secret from `render.yaml` that's marked `sync: false`. Specifically:

```
DATABASE_URL                    (Supabase pooled URL with ?pgbouncer=true)
DIRECT_URL                      (Supabase direct URL, port 5432)
REDIS_HOST                      (Upstash endpoint)
REDIS_PORT                      (Upstash port)
REDIS_PASSWORD                  (Upstash password)
JWT_SECRET                      (openssl rand -hex 32)
TICKET_QR_SIGNING_SECRET        (openssl rand -hex 32)

PAYSTACK_SECRET_KEY             (Paystack dashboard, sandbox keys for staging)
PAYSTACK_PUBLIC_KEY
MONNIFY_API_KEY                 (Monnify dashboard)
MONNIFY_SECRET_KEY
MONNIFY_CONTRACT_CODE
BLOCKRADAR_API_KEY              (Blockradar dashboard, optional for staging)
BLOCKRADAR_MASTER_WALLET_ID

BASE_SEPOLIA_DIAMOND_ADDRESS    0x4057170053DF6fA69C8579B71ce6288bd7cbA970
BLOCKCHAIN_RPC_URL              https://sepolia.base.org
DIAMOND_CONTRACT_ADDRESS        (legacy — same as BASE_SEPOLIA_DIAMOND_ADDRESS)

CIRCLE_API_KEY                  (from Circle console)
CIRCLE_ENTITY_SECRET            (the 64-char hex)
CIRCLE_WALLET_SET_ID            (UUID from circle:bootstrap-wallet-set)
CIRCLE_TREASURY_WALLET_SET_ID   (UUID from circle:bootstrap-treasury)
CIRCLE_TREASURY_WALLET_ID       (UUID from circle:bootstrap-treasury)

SENDGRID_API_KEY                (SendGrid dashboard, placeholder OK for staging)
SENDGRID_FROM_EMAIL             tickets@hostit.ng (or similar)
TWILIO_ACCOUNT_SID              (Twilio dashboard, placeholder OK for staging)
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER

CORS_ORIGINS                    (FE staging origin, e.g. https://staging.hostit.ng)
```

### 8. Trigger a deploy

Once env vars are saved, click **Manual Deploy → Deploy latest commit** in Render. The deploy runs:

1. `pnpm install --frozen-lockfile && pnpm prisma generate && pnpm build`
2. `pnpm dlx prisma migrate deploy` (preDeployCommand — applies all pending migrations against the live DB)
3. `node dist/main.js` (start the app)
4. Render polls `/api/healthz` until it returns 200, then routes traffic to the new instance.

Tail the logs in the dashboard. Look for:

```
[Bootstrap] Application running on http://localhost:3000/api
[Bootstrap] Swagger docs at http://localhost:3000/api/docs
[CircleService] Circle client initialized (env=sandbox, defaultChain=BASE-SEPOLIA)
```

### 9. Smoke test the live API

Render gives you a URL like `https://hostit-api-staging.onrender.com`. Test:

```bash
# Liveness
curl https://hostit-api-staging.onrender.com/api/healthz
# → { "status": "ok" }

# Full health (DB + Circle + per-chain RPC)
curl https://hostit-api-staging.onrender.com/api/health
# → all checks should be "up"

# Swagger docs
open https://hostit-api-staging.onrender.com/api/docs
```

### 10. Configure custom domain (optional)

In Render service → **Settings → Custom Domains**:

1. Add `api.staging.hostit.ng` (or whatever subdomain).
2. Render shows a CNAME target like `hostit-api-staging.onrender.com`.
3. In Cloudflare DNS for `hostit.ng`, add a CNAME: `api.staging` → `hostit-api-staging.onrender.com`. Set proxy mode (orange cloud) **off** while Render verifies, then turn it back on.
4. Wait for Render to issue the TLS cert (~minutes).
5. Update `CORS_ORIGINS` env var if frontend will use the custom domain.

### 11. Configure Circle webhook subscription (unblocks #65)

Once the URL is stable (Render default or custom domain):

1. Go to Circle Console → **Notifications → Subscriptions**.
2. Create a subscription pointing to `https://<your-url>/api/webhooks/circle`.
3. Subscribe to events: `transactions.outbound.success`, `transactions.outbound.failed`, `transactions.inbound.*`, `developer-controlled-wallet.*`.
4. Copy the **public key** + **key ID** Circle gives you.
5. Add to Render env:
   ```
   CIRCLE_WEBHOOK_PUBLIC_KEY    (the public key)
   CIRCLE_WEBHOOK_KEY_ID        (the key ID)
   ```
6. Trigger a redeploy so the new env vars are picked up.

After this, every Circle transaction lifecycle event lands at our backend. #65's webhook handler can then verify signatures + dispatch to the right state-update logic.

## Routine operations

### Deploys

- Push to `main` → Render auto-deploys (per `render.yaml`).
- Pre-deploy runs `prisma migrate deploy` automatically; no manual migration step.

### Rollback

In Render dashboard → **Deploys** → pick a past successful deploy → **Rollback to this deploy**. Database migrations are not rolled back automatically — schema changes require a new "down" migration if needed.

### Tailing logs

Render dashboard → **Logs**. For longer retention, ship to a service like Logtail or Datadog.

### Scaling

Render Starter is one instance. To horizontally scale, upgrade to **Standard** ($25/mo/instance) and bump instance count. BullMQ workers run inside the same process, so multiple instances mean multiple workers — Bull handles distributed coordination via Redis.

### Secret rotation

For each rotated secret:

1. Generate the new value.
2. Update in Render dashboard → Environment.
3. Save — Render triggers an auto-redeploy.
4. Old value is invalidated once the deploy completes.

For Circle entity secret rotation, follow `docs/circle-treasury-rotation.md` — that's a much bigger ceremony involving recreating wallets.

## Production cutover (later)

When you're ready to go from staging → production:

1. Spin up a separate Render service (`hostit-api-production`) using the same `render.yaml` (but on a `production` branch or a separate Blueprint).
2. Use a separate Supabase project + Upstash database.
3. Use **production** Circle account + production API keys.
4. Use **live** Paystack/Monnify keys.
5. Deploy contracts to **Base mainnet** and update `BASE_DIAMOND_ADDRESS`. Set `ACTIVE_CHAINS=BASE` (or `BASE-SEPOLIA,BASE` if you want to keep sandbox available).
6. Configure a separate Circle webhook subscription pointing at the prod URL.
7. Custom domain: `api.hostit.ng`.

## Troubleshooting

**Deploy fails with "Connection refused" to Postgres**
→ Check `DATABASE_URL` and `DIRECT_URL` are correctly set in Render env. Test the URL manually: `psql "$DATABASE_URL" -c "SELECT 1;"`.

**Migrations fail with "prepared statement" errors**
→ Migrations are running against the pooled URL. Make sure `DIRECT_URL` is set; `prisma.config.ts` falls back to `DATABASE_URL` only when `DIRECT_URL` is missing.

**`/api/healthz` returns 200 but `/api/health` shows blockchain "down"**
→ Render's egress can't reach the Base Sepolia RPC. Check `BLOCKCHAIN_RPC_URL` is correct + reachable from Render's IPs. Try a different RPC provider (Alchemy / QuickNode) if `sepolia.base.org` is rate-limiting.

**App boots but Bull workers don't process jobs**
→ Check `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`. Look for "BullMQ" log entries on startup. Upstash requires TLS — Prisma BullMQ auto-detects from the password presence but verify your URL format.

**Circle webhook signature verification fails**
→ Make sure `CIRCLE_WEBHOOK_PUBLIC_KEY` and `CIRCLE_WEBHOOK_KEY_ID` match the active subscription. Recreating a subscription invalidates the old keys.

**CORS blocked from frontend**
→ Set `CORS_ORIGINS` to the FE origin(s) and redeploy. The default (empty) allows all in dev but the warning logs flag this in production.

## Related docs

- [`docs/architecture.md`](./architecture.md) — system design overview
- [`docs/circle-treasury-rotation.md`](./circle-treasury-rotation.md) — rotating the platform treasury wallet
- [`docs/circle-gas-station.md`](./circle-gas-station.md) — sponsoring buyer gas
