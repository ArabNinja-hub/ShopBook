import {
  CreditTransaction,
  Customer,
  Product,
  Sale,
  SaleItem,
  StockAdjustmentMode,
  StockMovement,
} from '../domain/types';

export type ShopMemberRole = 'owner' | 'cashier';

export type EntitlementStatus =
  | 'pilot_free'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'expired_read_only'
  | 'suspended';

export interface ShopEntitlementView {
  planCode: string;
  planName: string;
  status: EntitlementStatus;
  isPilotExempt: boolean;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  currentPeriodEndsAt: string | null;
  allowNewSales: boolean;
  allowRepayments: boolean;
  allowExports: boolean;
  showPaymentPrompt: boolean;
  statusLabel: string;
}

export interface AuthUserView {
  id: string;
  fullName: string;
  phoneE164: string | null;
  email: string | null;
  recoveryCodeHint: string | null;
}

export interface AuthShopView {
  id: string;
  name: string;
  slug: string;
  role: ShopMemberRole;
  currencyCode: string;
  timezone: string;
  entitlement: ShopEntitlementView;
}

export interface AuthSessionResponse {
  authenticated: boolean;
  user: AuthUserView | null;
  shop: AuthShopView | null;
  memberships: Array<{
    shopId: string;
    shopName: string;
    role: ShopMemberRole;
  }>;
  /** Returned ONLY once at registration or explicit recovery-key rotation */
  issuedRecoveryKey?: string;
}

export type SyncOperationPayloadMap = {
  'shop.update_name': {
    shopName: string;
    updatedAt: string;
  };
  'product.create': {
    product: Product;
    initialMovement: StockMovement;
  };
  'product.update': {
    productId: string;
    name: string;
    unitLabel: string;
    sellingPriceNgwee: number;
    costPriceNgwee: number | null;
    lowStockThreshold: number;
    updatedAt: string;
  };
  'product.archive': {
    productId: string;
    isArchived: boolean;
    updatedAt: string;
  };
  'stock.adjust': {
    productId: string;
    mode: StockAdjustmentMode;
    quantity: number;
    movement: StockMovement;
    updatedAt: string;
  };
  'customer.create': {
    customer: Customer;
  };
  'customer.update': {
    customerId: string;
    name: string;
    phone: string;
    notes: string;
    updatedAt: string;
  };
  'sale.record': {
    sale: Sale;
    saleItems: SaleItem[];
    stockMovements: StockMovement[];
    creditTransaction: CreditTransaction | null;
  };
  'credit.repayment': {
    repayment: CreditTransaction;
    customerUpdatedAt: string;
  };
};

export type SyncOpType = keyof SyncOperationPayloadMap;

export interface SyncOperationEnvelope<K extends SyncOpType = SyncOpType> {
  operationId: string;
  opType: K;
  createdAt: string;
  payload: SyncOperationPayloadMap[K];
}

export interface StockConflictNotice {
  id: string;
  productId: string;
  productName: string;
  operationId: string;
  relatedSaleId: string | null;
  serverQtyBefore: number;
  requestedDeductionQty: number;
  shortfallQty: number;
  clampedQtyAfter: number;
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface SyncPushOperationResult {
  operationId: string;
  status: 'applied' | 'duplicate_noop';
  syncSeq: number;
  reassignedReceiptNumber?: string;
  stockConflict?: StockConflictNotice;
}

export interface SyncPushResponse {
  results: SyncPushOperationResult[];
  latestCursor: number;
  openStockConflicts: StockConflictNotice[];
  serverTime: string;
}

export type SyncEntityType =
  | 'shop_settings'
  | 'product'
  | 'customer'
  | 'sale'
  | 'stock_movement'
  | 'credit_transaction'
  | 'stock_conflict';

export interface SyncLedgerEntryView {
  seq: number;
  entityType: SyncEntityType;
  entityId: string;
  action: 'upsert' | 'delete';
  record: unknown;
  sourceOperationId: string | null;
  createdAt: string;
}

export interface SyncPullResponse {
  entries: SyncLedgerEntryView[];
  nextCursor: number;
  hasMore: boolean;
  entitlement: ShopEntitlementView;
  openStockConflicts: StockConflictNotice[];
  shopName: string;
  serverTime: string;
}
