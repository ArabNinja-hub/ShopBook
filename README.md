# ShopBook

**ShopBook** is a mobile-first sales, stock, and customer credit-book web application built for small shops, kiosks, and market stalls in Zambia.

> **Current Stage:** Milestone 2 — Local-First Operations + Pilot Shop Accounts, PostgreSQL API & Multi-Device Synchronization. ShopBook works offline-first in the browser's IndexedDB ledger and synchronizes idempotently with a Node.js + TypeScript + PostgreSQL backend across devices. Installable PWA service-worker caching is planned for Milestone 3.

---

## Core Capabilities

1. **Sell** — Search products, build a cart in minimal taps, and confirm **Cash**, **Mobile Money** *(manual record only — does not process electronic payments)*, or **Credit Book** sales with automatic stock deduction and double-tap protection.
2. **Stock** — Add, edit, archive/restore, and adjust product stock quantities with configurable low-stock alerts (default: `5` units), stock movement history, and multi-device stock conflict recount notices.
3. **Credit** — Track customers who buy on credit, view transaction-computed balances and running statements, and record Cash or Mobile Money debt repayments safely.
4. **Home & Reports** — Home opens with today's sales, money owed, up to five low-stock items and three actions (Record a sale, Add a product, View credit). **Reports** keeps the full detail — day totals, money breakdown, profit estimate, best sellers, receipt history and a day-by-day table — with the dense figures behind *More reports* so the main screen stays calm.
5. **Account & Cloud Sync (Milestone 2)** — Register a **Free Pilot Account** using a normalized Zambian mobile number (`097...`, `096...`, `095...`, `077...`, `+260...`) or email address + password, recover accounts safely via Emergency Recovery Keys (`SBRK-...`) or single-use Pilot Reset Codes (`SBRST-...`) without paid SMS, and synchronize sales, stock, and credit ledgers safely across devices.

---

## Quick Start (Windows PowerShell — No Paid Infrastructure Required)

Prerequisite: **Node.js 20+** (includes `npm`). Local development automatically uses embedded PostgreSQL (`./.local-pgdata`) with the exact same SQL migrations used in production.

```powershell
# 1. Move into the repository folder
Set-Location .\ShopBook

# 2. Install dependencies
npm install

# 3. Terminal 1: Start the Node.js + PostgreSQL API server (http://localhost:3001)
npm run dev:api

# 4. Terminal 2: Start the Vite web app (http://localhost:5173, proxies /api/* to :3001)
npm run dev
```

Open `http://localhost:5173` in your desktop browser or on an Android phone on the same Wi-Fi network.

### Quality, Database, Recovery & Build Commands (PowerShell)

```powershell
# Run full automated test suite (local operations, UI, auth, isolation, migrations, sync & concurrency)
npm test

# Run strict TypeScript type-checking (frontend + backend)
npm run typecheck

# Apply PostgreSQL SQL migrations explicitly
npm run db:migrate

# Issue a 30-minute single-use password reset code for a verified pilot shop owner
npm run admin:issue-reset -- --identifier 0977123456

# Create an optimized production build in .\dist
npm run build

# Verify the built HTML is safe for the configured public path
npm run verify:dist

# Build for the GitHub Pages project site (served from /ShopBook/)
npm run build:pages
```

---

## Deploying the frontend to GitHub Pages (optional, static only)

`.github/workflows/deploy-pages.yml` builds the app and publishes `dist/` to
<https://arabninja-hub.github.io/ShopBook/> on every push to `main`.

- **The public path matters.** A GitHub Pages *project* site is served from
  `/ShopBook/`, not `/`. The build therefore sets `VITE_BASE_PATH=/ShopBook/`;
  Vite's `base` is otherwise `/`, which is what Render needs when it serves
  `dist/` from the domain root. Never hardcode `/ShopBook/` in `vite.config.ts`.
- **The guard is not optional.** `npm run verify:dist` fails the build if the
  emitted `index.html` still references root-absolute assets such as
  `/assets/index-abc.js`. Those resolve outside `/ShopBook/` and cause the blank
  white page this project previously shipped.
- **Pages serves static files only.** The Fastify API and PostgreSQL in
  `server/` are *not* deployed there. Without that API the app runs offline
  against the phone's IndexedDB ledger, shows "Saved on this phone", and offers
  backup/restore instead of cloud sign-in. Host the API separately (see
  `docs/DEPLOYMENT_AND_BACKUPS.md`) if cloud sync is required.
- **Repository setting:** Pages must use **Settings → Pages → Source: GitHub
  Actions**. Publishing a raw branch is what produced the original white screen,
  because a branch checkout has no built `assets/` and no `/src/main.tsx` bundle.

---

## Architecture Overview

- `src/domain/` & `src/shared/` — Domain models (`types.ts`), integer-ngwee Kwacha math (`money.ts`), UUID & local-date helpers (`ids.ts`), Zambian E.164 phone & email normalization (`identifiers.ts`), and shared sync protocol types (`syncTypes.ts`).
- `src/db/indexedDb.ts` — Persistent local **IndexedDB** ledger (`shopbook_local_v1`, non-destructively upgraded to `v2`) with atomic multi-store `readwrite` transactions across `products`, `sales`, `saleItems`, `stockMovements`, `customers`, `creditTransactions`, `syncOutbox`, and `syncState`.
- `src/services/` — Local business & synchronization services (`stockService.ts`, `salesService.ts`, `creditService.ts`, `summaryService.ts`, `exportService.ts`, `shopService.ts`, `apiClient.ts`, `authClientService.ts`, `syncClientService.ts`).
- `server/` — Portable Node.js + Fastify + Drizzle ORM + PostgreSQL backend:
  - `server/db/migrations/0001_milestone2_foundation.sql` & `server/db/schema.ts` — Shop-isolated tables (`users`, `shops`, `shop_members` with `owner`/`cashier` roles, `auth_sessions`, `password_reset_tokens`, `billing_plans`, `shop_entitlements`, composite-PK ledger tables, `applied_operations`, `sync_ledger`, `stock_conflicts`, and `audit_logs`).
  - `server/auth/crypto.ts` & `server/services/authService.ts` — Memory-hard `scrypt` password & recovery-key hashing, SHA-256 hashed `HttpOnly` session tokens, CSRF verification, sliding-window rate limiting, and cross-shop isolation guards.
  - `server/services/syncService.ts` — ACID per-shop idempotent outbox push (`applied_operations`), monotonic cursor pull (`sync_ledger`), collision-safe daily receipt numbering, and non-destructive offline oversell clamping (`stock_conflicts` — completed sales and repayments are never discarded).
- `render.yaml` & `docs/DEPLOYMENT_AND_BACKUPS.md` — Deployment-ready Render configuration, verified USD/ZMW monthly cost (`$13.00/mo` / `~K262/mo`), database backup setup, and step-by-step restoration procedure.

---

## Branding Assets

- Original repository logo (preserved untouched): `./ShopBook Ledger Logo.png` (`1254×1254` RGB PNG).
- Web-ready lossless crops in `public/brand/` (`shopbook-logo.png` and `shopbook-icon.png`).
