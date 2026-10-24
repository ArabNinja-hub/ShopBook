# Privacy Policy — DRAFT (NOT PUBLISHED — NOT LEGAL ADVICE)

Status: DRAFT ONLY. Prepared for internal review before any pilot that collects personal or shop data. Not a final legal document. No company legal entity claimed.

Prepared: 2026-10-24
Based on: Verified ShopBook Milestone 2 behavior (README.md, docs/DEPLOYMENT_AND_BACKUPS.md, source inspection of src/db/indexedDb.ts, src/services/exportService.ts, server/db/schema.ts, server/auth/crypto.ts, server/routes/authRoutes.ts).

---

## 1. What This Document Covers

This policy explains what data ShopBook collects, how it is used, stored, shared (or not shared), retained, and protected for users of the pilot application. It reflects verified behavior only — nothing is claimed that is not supported by the code, documentation, or testing completed in Phase 2A.

---

## 2. Data Controller / Operator Identity (Unresolved)

The repository is hosted at `ArabNinja-hub/ShopBook`. The application is a pilot build by an independent developer. At this stage, no specific Zambian business entity, registered company name, or formal operator identity has been established for the pilot.

Unresolved policy decision: Should the operator be identified as the repository maintainer, a registered Zambian entity, or a separate pilot program? This must be decided before publishing this policy, because users need a point of contact.

---

## 3. Scope of Data Collection (From Source and Behavior)

ShopBook collects only the data needed to operate a local sales/credit-book ledger and synchronized server copy. No data is collected for advertising, profiling, or third-party sale.

### 3.1 Shop-Level Data
- Shop name (`shops.name`), slug, currency code (`currency_code`, default ZMW), timezone (`timezone`, default Africa/Lusaka), created-by user reference (`created_by_user_id`).
- No physical address is collected by the application; users enter only the name.

### 3.2 User Account Data (For Pilot Access)
- Normalized Zambian mobile phone number (E.164 format: `097...`, `096...`, `095...`, `077...`, or `+260...`).
- Email address (optional; used only if provided for account registration/recovery).
- Hashed password (`password_hash`, `scrypt`) — the application never stores the plain password.
- Recovery key hash (`recoveryCodeHash`) — used for account recovery; not stored in plain text.
- Session token (`sessionCookieName=sb_session`) — SHA-256 hashed server-side; transmitted via `HttpOnly; Secure; SameSite=Lax` cookie (configured in `render.yaml`: `COOKIE_SECURE=true`).
- CSRF verification token (`csrf` header) — required on state-changing requests.

No government ID, biometric data, bank account numbers, or electronic payment wallet credentials are collected.

### 3.3 Product & Stock Data
- Product names, unit labels, selling prices (integer Ngwee), optional cost prices, stock quantities, low-stock thresholds, archive flags, creation/update timestamps.
- Stock movement history (previous/new quantities, delta, reason, date).
- No supplier or vendor data is required.

### 3.4 Sale & Transaction Data
- Receipt number (`receipt_number` — daily collision-safe sequential number generated server-side), local date (`local_date`), payment method (`cash` / `mobile_money` / `credit`), total Ngwee (`total_ngwee`), total units (`total_units`), customer reference (optional for cash/mobile; required for credit), customer name snapshot at sale (`customer_name_snapshot`), cost/revenue breakdown (`knownCostTotalNgwee`, `knownCostRevenueNgwee`, `missingCostLineCount`, `missingCostRevenueNgwee`).
- Sale item records (product reference at sale, quantity, unit price at sale, line total).
- Note: Mobile Money payments are manually recorded — no electronic wallet access, no payment token, no transaction ID from a payment provider.

### 3.5 Customer Credit Data
- Customer name, phone (normalized), notes.
- Credit transactions (`credit_sale` / `repayment`) with amounts (Ngwee), dates, and repayment payment method (`cash` / `mobile_money`).
- Running balance computed from transaction history (not hardcoded).
- No external credit bureau data, no bank statements.

### 3.6 Device & Sync Data
- Local IndexedDB database (`shopbook_local_v1`, version 2) stores all of the above on the device persistently.
- Sync outbox (`syncOutbox`) holds pending operations (operation IDs, payloads, attempts, last error) until pushed to the server.
- Sync state (`syncState`) holds account binding (`boundShopId`, `boundShopName`, `boundUserId`), sync cursor (`cursor`), last sync error, and open stock-conflict notices.
- Backup files (JSON / CSV) may be downloaded by the user from the device and stored externally by the user.

---

## 4. How Data Is Processed

- **Local processing:** All business logic (sales, stock, credit, summaries) runs in the browser using IndexedDB transactions (`readwrite` across multiple stores atomically). No data leaves the device unless the user is signed in and sync occurs.
- **Synchronization:** When connected, the frontend pushes outbox operations to `/api/v1/sync` using a session-authenticated request with CSRF verification. The server applies operations idempotently (`applied_operations` table) and pulls new records using a monotonic cursor (`sync_ledger`). Cross-shop isolation is enforced (`shop_id` in all ledger tables, `shop_members` roles `owner`/`cashier`).
- **Backup (local):** `createFullBackupJson()` exports all local stores into a JSON file (`shopbook-backup-v1`) downloadable by the user. `restoreBackupFromJson()` validates and atomically replaces local stores (destructive). The JSON file does NOT include `syncOutbox` or `syncState` — users must reconnect to resume sync.
- **Backup (server):** When deployed, Render-managed PostgreSQL provides continuous WAL archiving (3-day PITR + 7-day logical exports). A weekly off-platform `pg_dump` is recommended but not automatically scheduled in the current repository. Restoration requires `pg_restore` into a disposable DB, verification of row counts, and migration checksum confirmation.
- **Security processing:** Passwords hashed with memory-hard `scrypt`; session tokens hashed with SHA-256; CSRF tokens verified; rate limits applied; audit logs (`audit_logs`) record security events (login, logout, unauthorized access attempts).

---

## 5. Data Sharing & Third Parties (Verified — None for Core Functions)

- **No advertising or analytics:** The application does not use Google Analytics, Facebook Pixel, or similar tracking.
- **No third-party payment processing:** Mobile Money is manual-only; no Airtel, MTN MoMo, or bank API integrations exist.
- **No third-party identity verification:** Phone/email normalization is done locally (`identifiers.ts`); no external identity provider (OAuth, OpenID, government ID service) is used.
- **No data sale:** The codebase and documentation do not contain any mechanism for sharing data with third parties.
- **Hosting:** If deployed via Render (Frankfurt region), data is stored on Render's managed PostgreSQL service. Render's privacy policy governs infrastructure-level access, not application-level data use. The user (pilot shop owner) does not control Render's internal access, but the database connection is restricted (`ipAllowList: []`) to private Render network only.

---

## 6. Data Retention & Deletion

- **Local:** IndexedDB persists on the device until the user clears browser data or deletes the database (via `resetDatabaseForTests()` in tests, or browser settings). The user can export JSON at any time.
- **Server:** PostgreSQL records persist as long as the database exists. Deletion is not automated; users do not have a self-service "delete account and all data" feature in the current application. The `users` table references `shops`; `shops` has `onDelete: 'cascade'` for `shop_members`; some tables have cascade references, but a full account-deletion workflow is not implemented.
- **Backup retention:** IndexedDB JSON export is user-controlled. PostgreSQL backups follow Render's retention (3-day PITR + 7-day logical exports). The recommended weekly `pg_dump` archive retention is not defined (user must define storage duration and deletion schedule).
- **Unresolved:** What is the retention period after a shop stops using the service? Should data be anonymized or deleted after X months? Not decided.

---

## 7. User Rights (Verified Capabilities + Unresolved Policy)

Verified capabilities:
- Export JSON/CSV from device (`Backup & Shop` feature).
- Restore from JSON (with validation; destructive to current local records).
- Recover account via Recovery Key or Admin Reset Code.
- Log out (revokes session; requires re-authentication).
- Update settings (shop name, product info, stock adjustments).

Not yet implemented / unresolved:
- Full self-service account deletion (with server data removal).
- Data portability beyond JSON/CSV (e.g., standard export format).
- Right to restrict processing (e.g., stop sync without losing local data).
- Right to object to specific data uses (not applicable currently, but should be defined if future features change).

---

## 8. Security Measures (Verified from Source)

- Password storage: `scrypt` (memory-hard) in `server/auth/crypto.ts`.
- Session security: SHA-256 hashed `HttpOnly` session cookie; CSRF verification (`server/middleware/csrf.ts`); sliding-window rate limiting.
- Database security: cross-shop isolation (`shop_id` in composite keys; `shop_members` role checks); `audit_logs` for security events.
- Network security: `COOKIE_SECURE=true` (production), `TRUST_PROXY=true`; `DATABASE_SSL=true`; `ipAllowList: []` for PostgreSQL; no public DB port exposure.
- Backup security: JSON export is local to device (user-controlled); PostgreSQL access restricted to private Render network; weekly `pg_dump` recommended to separate storage (not automatic, requires temporary IP access that must be removed after).

---

## 9. Children's / Vulnerable Users

Not addressed by application logic. The app has no age verification, no parental consent mechanism, and no specific protections for minors using the service. If a shop employs minors as cashiers or customers include minors, this is an unresolved policy gap.

---

## 10. International / Cross-Border

- Application is developed for Zambia (ZMW currency, Zambian mobile number formats, Africa/Lusaka timezone default, BoZ exchange rates referenced in docs).
- If hosted on Render Frankfurt (as configured in `render.yaml`), server data is stored in the EU.
- Users access from Zambia. This creates a cross-border data-flow scenario (Zambia → EU). No specific disclosure or transfer agreement is drafted.
- Unresolved: Should users be informed that server data is stored in the EU? Should a local/regional host be used instead? No decision made.

---

## 11. Changes from Previous Versions / Updates

Not applicable — this is the initial pilot draft. Future updates must include a changelog (e.g., new fields in `sales` or `products`, changes to sync protocol, changes to backup format `shopbook-backup-v1`) and must inform users if data format changes affect JSON backup compatibility.

---

## 12. How to Contact / Exercise Rights

Because no formal operator identity is established, this draft includes a placeholder:

- **Contact:** Repository maintainer via `ArabNinja-hub/ShopBook` (GitHub). No dedicated support email or phone number is configured.
- **Exercise rights:** Users may export their JSON backup, restore to a new device, or disconnect from sync (sign out). Full deletion or restriction requests must be handled manually until an automated workflow is implemented.
- **Unresolved:** Should a dedicated support channel (email/phone) be established? Should a formal data-protection officer (DPO) be designated? These are policy decisions requiring legal and business planning.

---

## 13. Policy Decisions Requiring Resolution Before Publishing

- [ ] Operator identity: repository maintainer vs registered Zambian entity vs separate pilot program?
- [ ] Governing law / jurisdiction: Zambian law? English common law? EU GDPR considerations (given Frankfurt hosting)?
- [ ] Age / capacity: minimum user age? No verification mechanism exists.
- [ ] Data retention: how long after shop stops using service? After pilot ends?
- [ ] Breach notification: procedure and timeline?
- [ ] Cross-border transfer: inform users of EU hosting? Seek local/regional alternative?
- [ ] Subscription / pricing: what are the exact terms when `ENFORCE_SUBSCRIPTIONS` is enabled?
- [ ] Liability cap / exclusion: what is the maximum liability (if any) for data loss / incorrect balances?
- [ ] Third-party integration: if mobile-money electronic processing is added, which provider and terms apply?
- [ ] Cookie / tracking consent: should a consent banner be added for session cookies?
- [ ] Contact / support mechanism: dedicated email/phone vs GitHub issues?

---

## 14. Verified Behavior Only — No Invented Claims

This draft describes only what is verified by Phase 2B audit and Phase 2A backup/restore testing:
- IndexedDB persistence, sync protocol, manual mobile-money recording, backup/restore mechanism, pilot exemption, scrypt/auth, CSRF, rate limits, cross-shop isolation.
- It does NOT claim: guaranteed uptime, electronic payment processing, automated backup without user action, regulatory compliance (other than design-level security), or company legal identity.
- Unresolved items are explicitly listed rather than hidden or invented.
EOF