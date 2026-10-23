# ShopBook Milestone 2 — Deployment, Verified Costs, Backups & Restoration Runbook

> **Status:** Prepared and tested locally. **No paid services or external deployments have been created.** Complete the backup verification checklist below before onboarding real pilot shopkeepers.

---

## 1. Verified Monthly Hosting & Database Cost

- **Research & verification date:** `2026-10-23`
- **Exchange rate reference:** `1 USD = 20.12 ZMW` (Bank of Zambia official daily mid-rate `20.1145–20.1203 ZMW` on `2026-10-23`, <https://www.boz.zm/markets-securities/boz-exchange-rates>)

### Primary Option: Render Unified Architecture (`render.yaml`)

| Component | Plan | USD / Month | Approx. ZMW / Month | Key Guarantees |
|---|---|---:|---:|---|
| Workspace | Render Hobby | `$0.00` | `K0` | Includes `5 GB/mo` outbound bandwidth |
| Web + API Server | Render Web Service (`starter`) | `$7.00` | `~K141` | `0.5 CPU`, `512 MB RAM`, 24/7 always-on (no cold-start spin-down), TLS, `/api/v1/health` checks, serves SPA (`dist/`) + `/api/v1/*` on one origin |
| Managed PostgreSQL 16 | Render Postgres (`basic-256mb`) | `$6.00` | `~K121` | `256 MB RAM`, `1 GB SSD` (`+$0.30/GB-mo` expansion), **3-day continuous Point-in-Time Recovery (PITR)** + **7-day logical exports** |
| **Total Initial Production** | | **`$13.00/mo`** | **`~K262/mo`** | Suitable for ~10–100 pilot shops |

> **Why Render Free Postgres (`$0`) is NOT used for real shop data:** Render Free PostgreSQL databases expire after **30 days** (and are permanently deleted 14 days later) with **zero backups** (<https://render.com/docs/free>). For `$0` local development before deployment, ShopBook runs embedded PostgreSQL (`@electric-sql/pglite` on `./.local-pgdata`) with the exact same SQL schema and migrations.

### Portable Alternative: Railway (`Hobby` -> `Pro`)

Because ShopBook uses standard Node.js 20/22+, `pg`, and standard SQL migrations (`npm run db:migrate`), the exact same repository runs unmodified on **Railway** (`$5/mo` Hobby minimum credit covering light pilot compute + CoW daily/weekly volume backups, ~`$5.00–$8.00/mo` / `~K101–K161/mo`, <https://docs.railway.com/pricing/plans>) or any managed PostgreSQL 16+ host.

---

## 2. Zero-Cost Local Development (Windows PowerShell)

No Docker, cloud account, or paid database is required to run the full frontend + backend + PostgreSQL stack locally:

```powershell
# Terminal 1 — Start the Node.js + Fastify API server (auto-migrates ./.local-pgdata)
npm run dev:api

# Terminal 2 — Start the Vite frontend dev server (proxies /api/* to http://127.0.0.1:3001)
npm run dev
```

To point local development at a native PostgreSQL 16+ server instead of `.local-pgdata`, set `DATABASE_URL` in `.env`:

```powershell
Copy-Item .env.example .env
# Edit DATABASE_URL=postgresql://postgres:password@localhost:5432/shopbook
npm run db:migrate
npm run dev:api
```

---

## 3. Database Backup Configuration (Mandatory Before Real Shop Data)

 ShopBook protects pilot financial and credit-book data across **three independent backup layers**:

### Layer 1: Render Managed Continuous PITR + Daily Logical Backups
1. On Render Paid Postgres (`basic-256mb` and higher), continuous WAL archiving (**Point-in-Time Recovery**: 3-day window on Hobby workspaces, 7-day window on Pro workspaces) and **daily logical exports** (retained 7 days) are enabled automatically (<https://render.com/docs/postgresql-backups>).
2. Keep `ipAllowList: []` in `render.yaml` during normal operation so the PostgreSQL port is reachable **only** from private Render services and never exposed to the public internet.

### Layer 2: Weekly Off-Platform Encrypted `pg_dump` Archive
Before onboarding real shopkeepers, schedule or run a weekly off-platform logical dump to separate storage so survival never depends on a single cloud vendor account:

```powershell
# Temporarily allow your admin IP in Render Postgres Networking, then run:
$STAMP = Get-Date -Format "yyyy-MM-dd-HHmm"
pg_dump --format=custom --no-owner --no-privileges "$env:RENDER_EXTERNAL_DATABASE_URL" --file="shopbook-prod-$STAMP.dump"
# Remove temporary admin IP from Render Postgres Networking immediately after completion.
```

### Layer 3: Local Device IndexedDB + Daily JSON Export
Every shop owner's phone keeps its persistent local **IndexedDB** ledger (`shopbook_local_v1` v2) and one-tap **Download Backup (JSON)** / **CSV** exports inside **Backup & Shop**, even if mobile connectivity or the server is temporarily unreachable.

---

## 4. Step-by-Step Database Restoration & Verification Procedure

**Test a restore into a disposable database BEFORE inviting real pilot shops:**

### Procedure A — Point-in-Time Recovery (Render Dashboard)
1. Open **Render Dashboard -> `shopbook-postgres` -> Recovery**.
2. Choose **Point-in-Time Recovery**, select the target UTC timestamp prior to the incident, and click **Recover into new database** (e.g., `shopbook-postgres-restored`).
3. Verify row counts and ledger integrity against the restored instance before switching traffic:
   ```sql
   SELECT COUNT(*) AS shops FROM shops;
   SELECT COUNT(*) AS sales, COALESCE(SUM(total_ngwee), 0) AS revenue_ngwee FROM sales;
   SELECT type, COUNT(*), COALESCE(SUM(amount_ngwee), 0) FROM credit_transactions GROUP BY type;
   ```
4. Update `DATABASE_URL` on `shopbook-app` to the restored database's internal connection string and trigger a restart.

### Procedure B — Restoring a `pg_dump` Custom Archive (`pg_restore`)
```powershell
# 1. Create an empty target PostgreSQL 16 database (never overwrite production directly!)
createdb shopbook_restore_verify

# 2. Restore schema and data cleanly
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="postgresql://localhost:5432/shopbook_restore_verify" .\shopbook-prod-YYYY-MM-DD-HHmm.dump

# 3. Run idempotent migrations check (confirms schema_migrations checksums match)
$env:DATABASE_URL = "postgresql://localhost:5432/shopbook_restore_verify"
npm run db:migrate
```

---

## 5. Step-by-Step Production Deployment Checklist (When Authorized)

1. **Verify quality gates locally:**
   ```powershell
   npm run typecheck
   npm test
   npm run build
   npm audit
   ```
2. **Provision via Render Blueprint (`render.yaml`):**
   - In Render Dashboard, select **New -> Blueprint** and connect the `ArabNinja-hub/ShopBook` repository.
   - Review the two resources (`shopbook-postgres` at `$6/mo` and `shopbook-app` at `$7/mo`).
   - Confirm `preDeployCommand: npm run db:migrate` completes and `/api/v1/health` returns `{"status":"ok","database":"ok"}`.
3. **Configure HTTPS & Custom Domain (optional):**
   - Attach your domain in Render (`shopbook-app -> Settings -> Custom Domains`); Render provisions/renews Let's Encrypt TLS certificates automatically.
   - Confirm `COOKIE_SECURE=true` and `TRUST_PROXY=true` are set so `sb_session` cookies always carry `HttpOnly; Secure; SameSite=Lax`.
4. **Pilot Password Recovery Support Command:**
   - If a pilot shop owner loses both their password and their personal Emergency Recovery Key (`SBRK-...`), verify the shop owner's identity and issue a single-use 30-minute Reset Code (`SBRST-...`) from the Render Shell:
     ```bash
     npm run admin:issue-reset -- --identifier 0977123456
     ```
