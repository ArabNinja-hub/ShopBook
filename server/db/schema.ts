import {
  bigint,
  bigserial,
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  fullName: text('full_name').notNull(),
  phoneE164: text('phone_e164').unique(),
  email: text('email').unique(),
  passwordHash: text('password_hash').notNull(),
  recoveryCodeHash: text('recovery_code_hash'),
  recoveryCodeHint: text('recovery_code_hint'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shops = pgTable('shops', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  currencyCode: text('currency_code').notNull().default('ZMW'),
  timezone: text('timezone').notNull().default('Africa/Lusaka'),
  createdByUserId: uuid('created_by_user_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shopMembers = pgTable(
  'shop_members',
  {
    id: uuid('id').primaryKey(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<'owner' | 'cashier'>().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('shop_members_unique_user').on(t.shopId, t.userId)]
);

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  activeShopId: uuid('active_shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  userAgent: text('user_agent'),
  ipAddress: text('ip_address'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  issuedChannel: text('issued_channel')
    .$type<'admin_cli' | 'email_request'>()
    .notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const billingPlans = pgTable('billing_plans', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  priceNgwee: bigint('price_ngwee', { mode: 'number' }),
  billingInterval: text('billing_interval').$type<'none' | 'monthly' | 'annual'>(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shopEntitlements = pgTable('shop_entitlements', {
  shopId: uuid('shop_id')
    .primaryKey()
    .references(() => shops.id, { onDelete: 'cascade' }),
  planCode: text('plan_code')
    .notNull()
    .references(() => billingPlans.code),
  status: text('status')
    .$type<
      | 'pilot_free'
      | 'trialing'
      | 'active'
      | 'past_due'
      | 'expired_read_only'
      | 'suspended'
    >()
    .notNull(),
  isPilotExempt: boolean('is_pilot_exempt').notNull().default(true),
  trialStartedAt: timestamp('trial_started_at', { withTimezone: true }),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodEndsAt: timestamp('current_period_ends_at', { withTimezone: true }),
  feeWaiverReason: text('fee_waiver_reason'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable(
  'products',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    unitLabel: text('unit_label').notNull().default(''),
    sellingPriceNgwee: bigint('selling_price_ngwee', { mode: 'number' }).notNull(),
    costPriceNgwee: bigint('cost_price_ngwee', { mode: 'number' }),
    stockQty: integer('stock_qty').notNull(),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(5),
    isArchived: boolean('is_archived').notNull().default(false),
    needsStockRecount: boolean('needs_stock_recount').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.id] })]
);

export const customers = pgTable(
  'customers',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    name: text('name').notNull(),
    phone: text('phone').notNull().default(''),
    notes: text('notes').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.id] })]
);

export const sales = pgTable(
  'sales',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    operationId: text('operation_id').notNull(),
    receiptNumber: text('receipt_number').notNull(),
    paymentMethod: text('payment_method')
      .$type<'cash' | 'mobile_money' | 'credit'>()
      .notNull(),
    paymentReference: text('payment_reference'),
    customerId: text('customer_id'),
    customerNameSnapshot: text('customer_name_snapshot'),
    totalNgwee: bigint('total_ngwee', { mode: 'number' }).notNull(),
    totalUnits: integer('total_units').notNull(),
    knownCostTotalNgwee: bigint('known_cost_total_ngwee', {
      mode: 'number',
    }).notNull(),
    knownCostRevenueNgwee: bigint('known_cost_revenue_ngwee', {
      mode: 'number',
    }).notNull(),
    missingCostLineCount: integer('missing_cost_line_count').notNull(),
    missingCostRevenueNgwee: bigint('missing_cost_revenue_ngwee', {
      mode: 'number',
    }).notNull(),
    note: text('note').notNull().default(''),
    localDate: text('local_date').notNull(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.id] }),
    unique('sales_shop_operation_unique').on(t.shopId, t.operationId),
    unique('sales_shop_receipt_unique').on(t.shopId, t.receiptNumber),
    foreignKey({
      columns: [t.shopId, t.customerId],
      foreignColumns: [customers.shopId, customers.id],
    }),
  ]
);

export const saleItems = pgTable(
  'sale_items',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    saleId: text('sale_id').notNull(),
    productId: text('product_id').notNull(),
    productNameAtSale: text('product_name_at_sale').notNull(),
    unitLabelAtSale: text('unit_label_at_sale').notNull().default(''),
    sellingPriceAtSaleNgwee: bigint('selling_price_at_sale_ngwee', {
      mode: 'number',
    }).notNull(),
    costPriceAtSaleNgwee: bigint('cost_price_at_sale_ngwee', {
      mode: 'number',
    }),
    quantity: integer('quantity').notNull(),
    lineTotalNgwee: bigint('line_total_ngwee', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.id] }),
    foreignKey({
      columns: [t.shopId, t.saleId],
      foreignColumns: [sales.shopId, sales.id],
    }),
    foreignKey({
      columns: [t.shopId, t.productId],
      foreignColumns: [products.shopId, products.id],
    }),
  ]
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    operationId: text('operation_id').notNull(),
    productId: text('product_id').notNull(),
    productNameSnapshot: text('product_name_snapshot').notNull(),
    type: text('type')
      .$type<'initial' | 'sale' | 'restock' | 'adjustment'>()
      .notNull(),
    deltaQty: integer('delta_qty').notNull(),
    previousQty: integer('previous_qty').notNull(),
    newQty: integer('new_qty').notNull(),
    reason: text('reason').notNull(),
    relatedSaleId: text('related_sale_id'),
    conflictNote: text('conflict_note'),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.id] }),
    unique('stock_movements_shop_operation_unique').on(t.shopId, t.operationId),
    foreignKey({
      columns: [t.shopId, t.productId],
      foreignColumns: [products.shopId, products.id],
    }),
  ]
);

export const creditTransactions = pgTable(
  'credit_transactions',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    id: text('id').notNull(),
    operationId: text('operation_id').notNull(),
    customerId: text('customer_id').notNull(),
    customerNameSnapshot: text('customer_name_snapshot').notNull(),
    type: text('type').$type<'credit_sale' | 'repayment'>().notNull(),
    amountNgwee: bigint('amount_ngwee', { mode: 'number' }).notNull(),
    paymentMethod: text('payment_method').$type<'cash' | 'mobile_money'>(),
    relatedSaleId: text('related_sale_id'),
    note: text('note').notNull().default(''),
    localDate: text('local_date').notNull(),
    recordedByUserId: uuid('recorded_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.id] }),
    unique('credit_tx_shop_operation_unique').on(t.shopId, t.operationId),
    foreignKey({
      columns: [t.shopId, t.customerId],
      foreignColumns: [customers.shopId, customers.id],
    }),
  ]
);

export const stockConflicts = pgTable(
  'stock_conflicts',
  {
    id: uuid('id').primaryKey(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    productId: text('product_id').notNull(),
    productName: text('product_name').notNull(),
    operationId: text('operation_id').notNull(),
    relatedSaleId: text('related_sale_id'),
    serverQtyBefore: integer('server_qty_before').notNull(),
    requestedDeductionQty: integer('requested_deduction_qty').notNull(),
    shortfallQty: integer('shortfall_qty').notNull(),
    clampedQtyAfter: integer('clamped_qty_after').notNull(),
    status: text('status').$type<'open' | 'resolved'>().notNull().default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByOperationId: text('resolved_by_operation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.shopId, t.productId],
      foreignColumns: [products.shopId, products.id],
    }),
  ]
);

export const appliedOperations = pgTable(
  'applied_operations',
  {
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    operationId: text('operation_id').notNull(),
    opType: text('op_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    resultSyncSeq: bigint('result_sync_seq', { mode: 'number' }).notNull(),
    resultSummaryJson: jsonb('result_summary_json').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.shopId, t.operationId] })]
);

export const syncLedger = pgTable('sync_ledger', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  shopId: uuid('shop_id')
    .notNull()
    .references(() => shops.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  action: text('action').$type<'upsert' | 'delete'>().notNull(),
  recordJson: jsonb('record_json').notNull(),
  sourceOperationId: text('source_operation_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey(),
  shopId: uuid('shop_id').references(() => shops.id, { onDelete: 'set null' }),
  actorUserId: uuid('actor_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  eventType: text('event_type').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  ipAddress: text('ip_address'),
  detailsJson: jsonb('details_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
