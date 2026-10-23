-- ShopBook Milestone 2 Foundation Schema (PostgreSQL 16+)
-- Accounts, shop memberships (owner/cashier), pilot entitlements, shop-isolated financial ledgers,
-- idempotent sync operations, cursor-based sync_ledger, stock conflict tracking, and audit logs.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone_e164 TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  recovery_code_hash TEXT,
  recovery_code_hint TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_contact_required CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS shops (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  currency_code TEXT NOT NULL DEFAULT 'ZMW',
  timezone TEXT NOT NULL DEFAULT 'Africa/Lusaka',
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shop_members (
  id UUID PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'cashier')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  invited_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shop_members_unique_user UNIQUE (shop_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_shop_members_user_id ON shop_members(user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  user_agent TEXT,
  ip_address TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  issued_channel TEXT NOT NULL CHECK (issued_channel IN ('admin_cli', 'email_request')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);

CREATE TABLE IF NOT EXISTS billing_plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_ngwee BIGINT CHECK (price_ngwee IS NULL OR price_ngwee >= 0),
  billing_interval TEXT CHECK (billing_interval IS NULL OR billing_interval IN ('none', 'monthly', 'annual')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO billing_plans (code, name, description, price_ngwee, billing_interval, is_active)
VALUES
  ('pilot_free', 'Free Pilot Access', 'Full ShopBook access for initial pilot shop owners with no payment prompts.', NULL, 'none', TRUE),
  ('future_trial', 'Configurable Trial (Future)', 'Placeholder plan for future time-boxed trial onboarding once trial policy is finalized.', NULL, 'none', FALSE),
  ('future_subscription', 'Shop Subscription (Future)', 'Placeholder plan for future paid subscriptions once ZMW pricing and gateway are activated.', NULL, 'monthly', FALSE)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS shop_entitlements (
  shop_id UUID PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL REFERENCES billing_plans(code),
  status TEXT NOT NULL CHECK (status IN ('pilot_free', 'trialing', 'active', 'past_due', 'expired_read_only', 'suspended')),
  is_pilot_exempt BOOLEAN NOT NULL DEFAULT TRUE,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  current_period_ends_at TIMESTAMPTZ,
  fee_waiver_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  unit_label TEXT NOT NULL DEFAULT '',
  selling_price_ngwee BIGINT NOT NULL CHECK (selling_price_ngwee > 0),
  cost_price_ngwee BIGINT CHECK (cost_price_ngwee IS NULL OR cost_price_ngwee >= 0),
  stock_qty INTEGER NOT NULL CHECK (stock_qty >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  needs_stock_recount BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (shop_id, id)
);

CREATE INDEX IF NOT EXISTS idx_products_shop_name ON products(shop_id, name);

CREATE TABLE IF NOT EXISTS customers (
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (shop_id, id)
);

CREATE INDEX IF NOT EXISTS idx_customers_shop_name ON customers(shop_id, name);

CREATE TABLE IF NOT EXISTS sales (
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  receipt_number TEXT NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'mobile_money', 'credit')),
  payment_reference TEXT,
  customer_id TEXT,
  customer_name_snapshot TEXT,
  total_ngwee BIGINT NOT NULL CHECK (total_ngwee > 0),
  total_units INTEGER NOT NULL CHECK (total_units > 0),
  known_cost_total_ngwee BIGINT NOT NULL CHECK (known_cost_total_ngwee >= 0),
  known_cost_revenue_ngwee BIGINT NOT NULL CHECK (known_cost_revenue_ngwee >= 0),
  missing_cost_line_count INTEGER NOT NULL CHECK (missing_cost_line_count >= 0),
  missing_cost_revenue_ngwee BIGINT NOT NULL CHECK (missing_cost_revenue_ngwee >= 0),
  note TEXT NOT NULL DEFAULT '',
  local_date TEXT NOT NULL,
  recorded_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (shop_id, id),
  CONSTRAINT sales_shop_operation_unique UNIQUE (shop_id, operation_id),
  CONSTRAINT sales_shop_receipt_unique UNIQUE (shop_id, receipt_number),
  CONSTRAINT sales_shop_customer_fk FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sales_shop_local_date ON sales(shop_id, local_date);
CREATE INDEX IF NOT EXISTS idx_sales_shop_created_at ON sales(shop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sale_items (
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  sale_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name_at_sale TEXT NOT NULL,
  unit_label_at_sale TEXT NOT NULL DEFAULT '',
  selling_price_at_sale_ngwee BIGINT NOT NULL CHECK (selling_price_at_sale_ngwee > 0),
  cost_price_at_sale_ngwee BIGINT CHECK (cost_price_at_sale_ngwee IS NULL OR cost_price_at_sale_ngwee >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  line_total_ngwee BIGINT NOT NULL CHECK (line_total_ngwee > 0),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (shop_id, id),
  CONSTRAINT sale_items_sale_fk FOREIGN KEY (shop_id, sale_id) REFERENCES sales(shop_id, id) ON DELETE CASCADE,
  CONSTRAINT sale_items_product_fk FOREIGN KEY (shop_id, product_id) REFERENCES products(shop_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sale_items_shop_sale ON sale_items(shop_id, sale_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name_snapshot TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('initial', 'sale', 'restock', 'adjustment')),
  delta_qty INTEGER NOT NULL,
  previous_qty INTEGER NOT NULL CHECK (previous_qty >= 0),
  new_qty INTEGER NOT NULL CHECK (new_qty >= 0),
  reason TEXT NOT NULL,
  related_sale_id TEXT,
  conflict_note TEXT,
  recorded_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (shop_id, id),
  CONSTRAINT stock_movements_shop_operation_unique UNIQUE (shop_id, operation_id),
  CONSTRAINT stock_movements_product_fk FOREIGN KEY (shop_id, product_id) REFERENCES products(shop_id, id)
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_shop_product ON stock_movements(shop_id, product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS credit_transactions (
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_name_snapshot TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit_sale', 'repayment')),
  amount_ngwee BIGINT NOT NULL CHECK (amount_ngwee > 0),
  payment_method TEXT CHECK (payment_method IS NULL OR payment_method IN ('cash', 'mobile_money')),
  related_sale_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  local_date TEXT NOT NULL,
  recorded_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (shop_id, id),
  CONSTRAINT credit_tx_shop_operation_unique UNIQUE (shop_id, operation_id),
  CONSTRAINT credit_tx_customer_fk FOREIGN KEY (shop_id, customer_id) REFERENCES customers(shop_id, id)
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_shop_customer ON credit_transactions(shop_id, customer_id, created_at ASC);

CREATE TABLE IF NOT EXISTS stock_conflicts (
  id UUID PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  related_sale_id TEXT,
  server_qty_before INTEGER NOT NULL,
  requested_deduction_qty INTEGER NOT NULL,
  shortfall_qty INTEGER NOT NULL,
  clamped_qty_after INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at TIMESTAMPTZ,
  resolved_by_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stock_conflicts_product_fk FOREIGN KEY (shop_id, product_id) REFERENCES products(shop_id, id)
);

CREATE INDEX IF NOT EXISTS idx_stock_conflicts_shop_status ON stock_conflicts(shop_id, status);

CREATE TABLE IF NOT EXISTS applied_operations (
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  op_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id),
  result_sync_seq BIGINT NOT NULL,
  result_summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shop_id, operation_id)
);

CREATE TABLE IF NOT EXISTS sync_ledger (
  seq BIGSERIAL PRIMARY KEY,
  shop_id UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('upsert', 'delete')),
  record_json JSONB NOT NULL,
  source_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_ledger_shop_seq ON sync_ledger(shop_id, seq ASC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  shop_id UUID REFERENCES shops(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  ip_address TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_shop_created ON audit_logs(shop_id, created_at DESC);
