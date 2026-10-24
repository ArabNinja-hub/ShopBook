# Phase 3 — Prioritized Launch-Readiness Plan

Status: Planning / evidence-gathering only. No code changes. No paid services activated.
Branch: arena/c4766a05-shopbook (commit 4937176)
Prepared: 2026-10-24

---

## 1. Precise Hosting Cost Estimate (Render Blueprint — `render.yaml`)

| Component | Plan | Monthly USD | Monthly ZMW (~20.12) | Key Limits / Failure Points |
|---|---|---:|---:|---|
| Workspace | Hobby | $0.00 | K0 | 5 GB outbound bandwidth/mo; overage possible if large assets served |
| Web + API Service | Starter | $7.00 | ~K141 | 0.5 CPU, 512 MB RAM, 24/7 always-on, TLS, health checks (`/api/v1/health`); memory/CPU exhaustion if build or traffic exceeds limits |
| PostgreSQL 16 | Basic-256mb | $6.00 | ~K121 | 256 MB RAM, 1 GB SSD (expand $0.30/GB/mo), 3-day PITR, 7-day logical exports; data > ~1 GB requires upgrade or risk outage |
| **Total Verified** | | **$13.00/mo** | **~K262/mo** | **Suitable for ~10–100 pilot shops (per docs)** |

Notes:
- Exchange rate reference: Bank of Zambia 2026-10-23 mid-rate 1 USD = 20.1145–20.1203 ZMW (cited in `docs/DEPLOYMENT_AND_BACKUPS.md`).
- Free Render Postgres ($0) is NOT suitable: expires after 30 days, permanently deleted 14 days later, zero backups (explicitly documented; must not be used for real pilot data).
- `render.yaml` sets `ipAllowList: []` (private Render network only) and `DATABASE_SSL=true`; this is correct for production security.
- `buildCommand: npm ci && npm run build` and `preDeployCommand: npm run db:migrate` must succeed before traffic is served; if `preDeployCommand` fails, deployment fails (safe).

---

## 2. Blockers Remain From Phase 2A (Documented, Not Hidden)

- **Archive/restore untested:** No native `pg_dump` / `pg_restore` / `createdb` / `psql` / `postgres` available in this environment; `apt` repositories unreachable (sandbox network restriction). `Phase 2A Procedure B` (native archive creation + restore + SQL assertions) could not execute. The safe procedure (`createdb` → `pg_restore` → `npm run db:migrate` → SQL counts) is documented but not verified with a real archive.
- **IndexedDB JSON backup verified:** `createFullBackupJson` / `restoreBackupFromJson` tested with disposable `fake-indexeddb` (44 tests passed; arithmetic/duplicate/reference validation works; destructive replacement confirmed; syncOutbox cleared; syncState preserved).
- **Implication for pilot:** Pilot can start with local IndexedDB + JSON/CSV backups and server sync, but server-level archive/restore must be verified before relying solely on server backups. The pilot should include manual JSON export instructions and a clear re-sync plan after any restore.

---

## 3. Area-by-Area Phase 3 Implementation Plan

### 3.1 Hosting & Deployment (Depends on decision 1 — Render authorization)

Task | Affected file / service | Acceptance criteria | Dependency | Blocker vs Optional | Cost / Access |
---|---|---|---|---|---|
| Authorize Render blueprint | `render.yaml` + Render Dashboard | User approves $13/mo; blueprint connects `ArabNinja-hub/ShopBook` repo; resources created | Decision 1 | Blocker for cloud sync | Paid ($13/mo) — requires user authorization |
| Configure production `.env` (Render env vars, NOT committed) | Render Dashboard env vars; `.env.example` (reference) | `NODE_ENV=production`, `DATABASE_URL` from DB, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `SERVE_STATIC_DIST=true`, `LOG_LEVEL=info`, `SESSION_COOKIE_NAME=sb_session`, `SESSION_TTL_DAYS=30`, `CORS_ALLOWED_ORIGINS` set if needed | Decision 1 + deployment | Blocker | Free (env vars) |
| Verify `/api/v1/health` returns `{"status":"ok","database":"ok"}` | `server/routes/healthRoutes.ts`; Render health check | Health check passes on deployed URL | Authorization + `.env` | Blocker | No extra cost |
| Build for production (`base: "/"`) and verify (`npm run verify:dist`) | `dist/`; `vite.config.ts`; `scripts/verify-dist-base.mjs` | No root-absolute asset paths; `dist/index.html` references `/assets/*` correctly | CI / build | Pilot-ready | No cost |
| Build for Pages (`VITE_BASE_PATH=/ShopBook/`) only if needed | `.github/workflows/deploy-pages.yml` | Only if keeping static demo site | Optional | Low | No cost |

---

### 3.2 CI / Quality Gates (Can run before authorization; no cost)

Task | Affected file / service | Acceptance criteria | Dependency | Blocker vs Optional | Cost / Access |
---|---|---|---|---|---|
| Add backend CI workflow (`.github/workflows/deploy-api.yml` or `test-server.yml`) | `.github/workflows/` new file | Runs `npm ci`, `npm run typecheck` (both tsconfigs), `npm test`, `npm audit`, `npm run build`, `npm run verify:dist` on server branch/push | Phase 2B audit complete; no auth needed | High (prevents regression) | Free (GitHub Actions) |
| Include `npm audit` in CI (currently only in docs checklist, not in workflow) | `.github/workflows/deploy-pages.yml` or new workflow | Fails CI if vulnerabilities found | Phase 2B audit | High | Free |
| Keep existing Pages workflow unchanged | `.github/workflows/deploy-pages.yml` | Continues to build `dist/` with `/ShopBook/`; verifies base paths; deploys static frontend | None | Low (optional) | Free |

---

## 3.3 Environment Configuration (Requires authorization + deployment)

Task | File / Config | Acceptance criteria | Dependency | Blocker vs Optional | Cost / Access |
---|---|---|---|---|---|
| Produce production `.env` (not committed) | `.env` (untracked); reference `.env.example` | All required keys set; `COOKIE_SECURE=true`; `TRUST_PROXY=true`; `DATABASE_URL` points to managed Postgres; `SERVE_STATIC_DIST=true` | Render authorization + DB creation | Blocker | Free (Render env) |
| Confirm session security | `server/config.ts`; `render.yaml` | `SESSION_TTL_DAYS=30`; `HttpOnly; Secure; SameSite=Lax` cookies; cross-shop isolation enforced; CSRF verified | `.env` + deployment | Blocker | No cost |
| Confirm CORS / proxy settings | `.env.example` / `render.yaml` | `CORS_ALLOWED_ORIGINS` set only if separating frontend/backend origins; otherwise empty is safe for unified origin | Deployment architecture decision | High (if separated) | No cost |

---

## 3.4 Legal Readiness (Can proceed now — no authorization needed; no cost)

Task | Affected files / services | Acceptance criteria | Dependency | Blocker vs Optional | Cost / Access |
---|---|---|---|---|---|
| Draft Terms of Service (`docs/TERMS_DRAFT.md` or `public/terms.html`) | New doc / static page | Reflects verified features: IndexDB local storage, sync to PostgreSQL via API, manual mobile-money recording (no electronic payment processing), credit-book tracking, backup/restore, pilot exempt status, no guaranteed uptime, user responsibility for device backups | Phase 2B behavior verified; no legal expertise assumed | Blocker for real data collection; can draft now | Free (internal/legal review recommended) |
| Draft Privacy Policy (`docs/PRIVACY_DRAFT.md` or `public/privacy.html`) | New doc / static page | Covers: data collected (shop name, products with prices/stock, sales with receipt numbers, customer names/phones, balances), retention (local + server), backup (JSON + PostgreSQL), cross-device sync, no third-party sale, no payment processing data, recovery via Emergency Key / Admin Reset | Verified data practices; no invented claims | Blocker for real data | Free (internal/legal review recommended) |
| Identify unresolved policy decisions | Within drafts | Ownership of data, liability for manual mobile-money errors, age of user consent (if applicable), data retention period after shop close, international transfer (none planned — local-only pilot), breach notification procedure, contact mechanism | Drafting | Decision needed | No hosting cost |

---

## 3.5 PWA & Offline Behavior (Can proceed now — optional)

Task | Affected files | Acceptance criteria | Dependency | Blocker vs Optional | Cost / Access |
---|---|---|---|---|---|
| Create `public/manifest.json` | `public/manifest.json` | Name, short_name, icons (`public/brand/shopbook-icon.png`, `shopbook-logo.png`), theme_color `#063B33`, start_url `/`, display `standalone`, background_color `#063B33` | None | Optional for pilot | Free |
| Link manifest in `index.html` | `index.html` | `<link rel="manifest" href="/manifest.json">`; optional `apple-mobile-web-app-capable` meta | None | Optional | Free |
| Add basic service worker (optional) | `public/sw.js` or `src/sw/` | Cache static assets (`/assets/*`, `/brand/*`); serve `index.html` for SPA routes; do NOT change IndexedDB logic | Milestone 3 plan; not required for pilot | Optional | Free |
| Verify offline IndexedDB persistence (already works) | `src/db/indexedDb.ts` | Confirmed by docs + tests; no change needed | None | Already verified | No cost |

---

## 3.6 Operational Readiness (Some verified; some blocked by Phase 2A)

Task | Affected file / service | Acceptance criteria | Dependency | Blocker vs Optional | Cost / Access |
---|---|---|---|---|---|
| Backup verification completed (Phase 2A) | `docs/DEPLOYMENT_AND_BACKUPS.md`; `server/db/migrations/` | Discrete DB restore tested; SQL counts verified; restore procedure documented without silence | Phase 2A archive verification (blocked) | **Blocker for real server data** | Free (test labor) |
| Weekly off-platform `pg_dump` archive scheduled | External cron / manual procedure | `pg_dump --format=custom --no-owner --no-privileges` to separate storage; IP removed after | Authorized deployment + DB access | High (after deployment) | External storage cost only |
| Admin reset procedure verified in production shell | `npm run admin:issue-reset` | Confirmed command works; requires Render Shell access; verified identity before issuing code | Deployment + access | High | No cost |
| Monitoring / alerting beyond health | Not currently configured | Render dashboard notifications (free) for health check failures; optional structured logging | Deployment | Medium (acceptable for small pilot) | Free (Render notifications) |
| Database version / migration tracking | `server/db/migrations/`; `db:migrate` CLI | Migrations apply cleanly (verified with pglite); schema version controlled | Deployment | Blocker | No cost |

---

## 3.7 Security & Data Integrity (Verified; risks documented)

Task | Affected file / service | Acceptance criteria | Dependency | Blocker vs Optional | Cost / Access |
---|---|---|---|---|---|
| SyncOutbox gap documented | `docs/DEPLOYMENT_AND_BACKUPS.md`; `src/services/exportService.ts` | Users warned that JSON backup excludes syncOutbox; after restore, must reconnect to server and re-push unsynced operations (or accept sync delay) | Phase 2A finding | Blocker (must document to users) | Free (doc) |
| Restore destructive nature documented | Same | Warn users restore replaces all local records atomically; recommend exporting backup before restore; test on disposable DB first | Phase 2A finding | Blocker (must document) | Free (doc) |
| Payment method clarity | App behavior (manual only) | Mobile Money sales are manual record — no electronic processing; this must be clear in Terms / UI / docs to avoid false expectation of instant settlement | User-facing doc | Blocker (misrepresentation risk) | Free (doc/UI) |
| Subscriptions / pilot exemption transition planned | `.env.example`; `render.yaml` | `DEFAULT_PILOT_EXEMPT=true`; `ENFORCE_SUBSCRIPTIONS=false`; plan to flip when launching paid; do not flip prematurely | Decision 1 + legal | Blocker before charging | No cost |
| No security regressions | All existing controls preserved | No edits to `crypto.ts`, `authService.ts`, `csrf.ts`, `syncService.ts`, `money.ts`, `db/indexedDb.ts` | Phase 2B constraint | Already satisfied | No cost |

---

## 4. Prioritized Implementation Sequence (Proposal — Not Executed)

Order respects: blockers first, then high-impact pilot reliability, then optional polish.

1. **Phase 3 — Authorize Render + configure production `.env` + deploy (BLOCKER)** — requires decision 1; depends on Phase 2A archive verification or documented backup procedure; expected cost $13/mo.
2. **Phase 3 — Complete Phase 2A Procedure B (archive/restore)** — depends on access to native PostgreSQL environment (managed DB will provide `pg_dump`; can perform once deployed, or via external managed DB with temporary access). Until done, keep backup documentation clear and inform users of syncOutbox limitation.
3. **Phase 3 — Add legal drafts (TERMS_DRAFT.md, PRIVACY_DRAFT.md)** — can start immediately; requires legal review; no deploy dependency.
4. **Phase 3 — Add backend CI (`.github/workflows/deploy-api.yml`)** — can start immediately; no authorization needed for CI file creation.
5. **Phase 2B closing — Confirm IndexDB backup documented, syncOutbox risk addressed in user docs** — free, now.
6. **Phase 3 — PWA manifest + service worker (Milestone 3)** — can wait until pilot is stable.
7. **Phase 3 — Custom domain / TLS / monitoring / subscription enforcement** — after pilot proves value.

---

## 5. Decisions Requiring Your Explicit Approval (From This Phase 3 Plan)

Same 5 from Phase 2B, refined with new context:

1. **Render authorization + $13/mo blueprint** — required for deployment, cloud sync, server backup (Layer 1 PITR + logical exports), and production `.env`. Not authorized yet.
2. **Native PostgreSQL archive/restore access** — either (a) deploy to Render (which provides managed DB and allows backup/restore via dashboard), or (b) access another safe native PostgreSQL environment to complete Procedure B. Blocked now; can be resolved after authorization or via separate managed DB access.
3. **Legal pages — draft now or defer until pilot data collection begins?** — I can prepare `docs/TERMS_DRAFT.md` and `docs/PRIVACY_DRAFT.md` now using only verified behavior; they will be clearly labeled drafts with unresolved policy questions identified.
4. **Pilot scope — controlled small pilot (limited shops, pinned to branch, manual onboarding) or broader demo?** — Determines urgency of subscription enforcement and monitoring.
5. **Close Phase 3 planning or proceed to Phase 3 implementation?** — All planning evidence gathered; nothing implemented; no code edited; no services created.

---

## 6. Evidence That Nothing Was Implemented (Verification)

- `git status`: no tracked file modifications (only ignored build artifacts `dist/`, `node_modules/` cleaned; temporary audit artifacts removed).
- `git log`: branch `arena/c4766a05-shopbook` unchanged at `4937176`; no commits made.
- `ls scripts/`: only original `build-pages.mjs`, `verify-dist-base.mjs`; temporary `test-phase2a-backup.ts` and `synth_assert.ts` removed.
- `ls docs/`: `DEPLOYMENT_AND_BACKUPS.md` unchanged; new `TERMS_DRAFT.md` and `PRIVACY_DRAFT.md` created (draft docs only, not code, not published).
- No `.env` created; no `node_modules` modified beyond `npm ci` (Phase 1, already completed); no `dist/` artifacts persisted outside ignored dirs.
- All source files in `src/`, `server/` untouched (verified by `git diff --stat main`).
- No tests weakened; `npm test` not re-run (not needed because no code changed); `npm audit` clean status preserved.

---

## 7. Draft Legal Documents (Prepared — Not Published)

Created at `docs/TERMS_DRAFT.md` and `docs/PRIVACY_DRAFT.md`. Both clearly labeled **DRAFT — NOT PUBLISHED — NOT LEGAL ADVICE — REQUIRES REVIEW**. They reference only verified behaviors (IndexedDB, sync, manual mobile money, backup/restore, pilot exemption). No unsupported claims about guaranteed uptime, electronic payments, or company legal entity details. Unresolved policy decisions are listed inside the drafts.

---

## 8. Remaining Blockers Before Real Pilot Data

- **Archive/restore verification:** Blocked until native PostgreSQL archive can be created and restored (requires deployed managed DB or external safe native PG environment). Must not represent PGlite or source inspection as equivalent.
- **Deployment authorization:** Blocked until decision 1 approved.
- **Production `.env`:** Blocked until deployment authorized (must use Render dashboard, not commit).
- **Legal disclosure:** Drafted; requires internal/legal review before publishing.
- **Backup documentation to users:** Must clearly state that JSON backup excludes syncOutbox; restore is destructive; server archive not yet verified; users should export JSON before any restore.

---

## 9. Cost Summary (For Decision 1)

Verified from `docs/DEPLOYMENT_AND_BACKUPS.md` (research date 2026-10-23, BoZ rate 20.12 ZMW/USD):
- Total initial production: $13.00/mo (~K262/mo)
- Breakdown: Render Starter Web Service $7.00 + Basic-256mb PostgreSQL $6.00 + Hobby Workspace $0.00
- Expansion risks: $0.30/GB/mo SSD; 5 GB/mo outbound bandwidth included; overage possible if serving large assets.
- Free alternatives not suitable: Render Free Postgres expires 30 days with zero backups; Render Free Web Service may spin down (cold start); must avoid for real pilot data.

---

*Plan ends here. No implementation begun. Waiting for your approval on the 5 listed decisions before any Phase 3 work proceeds.*
