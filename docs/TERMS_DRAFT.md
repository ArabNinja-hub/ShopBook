# TERMS OF SERVICE — DRAFT (NOT PUBLISHED — NOT LEGAL ADVICE)

Status: DRAFT ONLY. Prepared for internal review before any public pilot. Not a final legal document. No company legal entity is claimed; this is a pilot service operated through the ArabNinja-hub / ShopBook repository.

Prepared: 2026-10-24
Based on: Verified ShopBook Milestone 2 behavior (index.html, README.md, docs/DEPLOYMENT_AND_BACKUPS.md, source inspection of src/services/exportService.ts, server/auth/crypto.ts, server/db/schema.ts, server/services/syncService.ts).

---

## 1. What ShopBook Does (Verified)

ShopBook is a mobile-first sales, stock, and customer credit-book web application for small shops in Zambia. It runs in the browser using a local IndexedDB ledger (`shopbook_local_v1`, non-destructively upgraded to `v2`). It can work offline and synchronizes idempotently with a Node.js + TypeScript + PostgreSQL backend when connected.

Verified capabilities (from README.md and code inspection):
- Record sales (Cash, Mobile Money — manual record only; does NOT process electronic payments), and Credit Book sales.
- Track product stock with configurable low-stock alerts and stock movement history.
- Track customer credit balances and repayments.
- Export/import JSON and CSV backups from the device.
- Register a free pilot account using a normalized Zambian mobile number or email + password.
- Recover account via Emergency Recovery Key or single-use Pilot Reset Code.
- Synchronize data across devices using an idempotent outbox (`applied_operations`) and monotonic cursor pull (`sync_ledger`).

Not verified / not promised: Electronic payment processing, guaranteed uptime, automated data recovery across devices without manual backup export, paid subscriptions (pilot only currently).

---

## 2. Service Description & Limitations

This is a pilot service. It is provided as-is for evaluation by small shops and kiosks. Key limitations that must be communicated to users:

- **Manual Mobile Money:** Mobile Money sales are recorded manually. ShopBook does not integrate with Airtel Money, MTN MoMo, or any electronic payment gateway. Users must record the payment themselves.
- **No Warranty:** There is no guarantee of uninterrupted service, data permanence, or automatic server-side backup beyond the documented Layer 1 (Render PITR/logical exports) and Layer 2 (manual weekly pg_dump) procedures, which require explicit authorization and setup.
- **Local First:** The primary record is on the device (IndexedDB). If the device is lost, broken, or cleared, the server-sync state is the only other copy — and only for data that has successfully synchronized.
- **Backup & Restore:** Users may export a JSON backup from the device and restore it to the same or another device. The JSON backup includes products, sales, sale items, stock movements, customers, credit transactions, and shop settings. It does NOT include the sync outbox (`syncOutbox`) or full server sync state (`syncState`); after a restore, users must reconnect to the server to re-establish synchronization. Restoration replaces all included local records atomically (destructive, not merged). Users should export a fresh JSON file before any restore.
- **Pilot Exemption:** Pilot shops receive unrestricted access without payment prompts (`DEFAULT_PILOT_EXEMPT=true`, `ENFORCE_SUBSCRIPTIONS=false`). This will change when paid subscriptions are implemented.

---

## 3. Data Collected (From Source and Behavior)

ShopBook collects the minimum data needed to operate a sales/credit-book ledger for a shop:

- **Shop:** name, slug, currency code (default ZMW), timezone (default Africa/Lusaka), created-by user reference.
- **Products:** name, unit label, selling price (ZMW, integer ngwee), cost price (if known), stock quantity, low-stock threshold, archive flag.
- **Sales:** receipt number, local date, payment method (`cash` / `mobile_money` / `credit`), total Ngwee, units sold, customer reference (optional for cash/mobile), payment reference (optional for mobile), note.
- **Sale Items:** product reference at sale, quantity, unit price at sale, cost price at sale (if known), line total.
- **Customers:** name, phone (normalized), notes.
- **Credit Transactions:** type (`credit_sale` / `repayment`), amount (Ngwee), date, payment method for repayment (cash / mobile_money), customer reference.
- **Stock Movements:** product reference, previous/new quantity, delta, date, reason.
- **Account / Auth:** normalized Zambian mobile number (E.164)`097...`, `096...`, etc.), or email address + hashed password (`scrypt`), recovery key hash, session token (SHA-256 hashed, `HttpOnly` cookie), CSRF verification.
- **Sync / Audit:** sync outbox (`operationId`, sequence, payload, attempts), applied operations ledger (`shop_id`, `operation_id`, result), sync cursor, audit logs (security/access events).

No payment card data, bank account details, or third-party identity verification data is collected (except the optional email/phone for account recovery). Mobile Money transactions are manual-only — no electronic wallet access.

---

## 4. How Data Is Used (Verified from Source)

- Local IndexedDB ledger is the primary store (atomic multi-store readwrite transactions).
- PostgreSQL backend stores isolated per-shop tables (`shops`, `users`, `shop_members`, `auth_sessions`, `sales`, etc.) with cross-shop isolation guards.
- Sync protocol is idempotent: duplicate retries of `(shop_id, operation_id)` return `duplicate_noop`; outbox is pushed monotonically; conflicts are clamped safely.
- Backup/restore: JSON export from IndexedDB; PostgreSQL PITR + logical exports for server backup.
- Data is not sold or shared with third parties. The application does not use advertising, analytics, or external tracking beyond what is required for basic operation.

---

## 5. User Responsibilities (To Be Disclosed)

- Keep device backups (JSON export / CSV) regularly, especially before any restore or device change.
- Protect Emergency Recovery Key (`SBRK-...`) and Pilot Reset Code (`SBRST-...`) securely; do not share with others.
- Understand that mobile-money sales are manually recorded and do not involve electronic settlement.
- Understand that server backup depends on deployment authorization (Phase 2A blocker currently); until then, only device-local backups are guaranteed.
- Reconnect to the server after any restore to resume sync; syncOutbox is not included in JSON backup and must be rebuilt via server push.

---

## 6. Pilot Status & Limitations (Verified)

- This is a pilot for small shops in Zambia. It has not been audited as a financial-system software by a regulatory authority.
- No guaranteed uptime, no SLA, no compensation for data loss (beyond the backup/restore mechanisms described).
- Free pilot access is granted (`DEFAULT_PILOT_EXEMPT=true`) without subscription payment. A future subscription model (`ENFORCE_SUBSCRIPTIONS`) is planned but not active.
- Users must verify their own data accuracy (prices, quantities, credit balances) because the application records what is entered; it does not independently verify physical stock or cash handling.

---

## 7. Unresolved Policy Decisions (Requires Human Review Before Publishing)

These are explicitly NOT decided by this draft. They must be resolved before any legal publication or pilot onboarding at scale:

- **Entity / Operator:** Should the Terms name `ArabNinja-hub` (GitHub repository owner), a specific Zambian business entity, or remain generic? No legal incorporation is confirmed.
- **Jurisdiction / Governing Law:** Should disputes be governed by Zambian law, English common law, or another? No choice made.
- **Age / Capacity:** Is there a minimum age for pilot users? Not defined by application logic (no age verification step).
- **Data Retention:** How long after a shop stops using the service should server data and device backups be retained? No retention schedule is implemented.
- **Breach Notification:** What is the procedure if server data is accessed improperly? No breach process is implemented.
- **Third-Party Integration:** If mobile-money electronic processing is ever added, which provider and what terms apply? Not planned now.
- **Subscription / Payment Terms:** What are the exact terms for transition from pilot exempt to paid? `billing_plans` table exists in schema, but no pricing or terms are defined.
- **Liability Cap:** Should liability for data loss or incorrect credit balances be capped at the pilot subscription amount (zero while exempt) or excluded entirely?
- **Contact / Support:** Should users contact via GitHub repository, a Zambian phone number, or an email? No support channel is documented.
- **Cookie / Tracking:** Should a cookie consent mechanism be added? Currently only session cookie (`sb_session`) is used.
- **Cross-Border Data:** The app runs on Render (Frankfurt region in `render.yaml`) with Zambian users; data may be processed in EU. No cross-border disclosure is drafted.

---

## 8. How This Draft Was Produced

- Only verified application behavior (from source, README, docs, and Phase 2A testing) was used.
- No unsupported claims about payment processing, uptime guarantees, regulatory compliance, or company identity.
- Unresolved decisions are listed explicitly rather than hidden.
- This is not legal advice. Review by a qualified legal professional in Zambia (and potentially the EU, given Render Frankfurt hosting) is required before publishing.
EOF