/**
 * Core domain models for ShopBook (Milestone 1 — Local-First Shop Operations).
 */

export type SalePaymentMethod = 'cash' | 'mobile_money' | 'credit';
export type RepaymentPaymentMethod = 'cash' | 'mobile_money';
export type StockMovementType = 'initial' | 'sale' | 'restock' | 'adjustment';
export type StockAdjustmentMode = 'add' | 'subtract' | 'set';
export type CreditTransactionType = 'credit_sale' | 'repayment';

export interface ShopSettings {
  key: 'shopSettings';
  shopName: string;
  hasDemoData: boolean;
  lastBackupAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  name: string;
  /** Optional pack/unit label such as "2kg bag", "500ml", "loaf", "each" */
  unitLabel: string;
  /** Selling price per unit in integer ngwee */
  sellingPriceNgwee: number;
  /** Cost price per unit in integer ngwee when known, or null if not recorded */
  costPriceNgwee: number | null;
  /** Current quantity in stock (whole units, never negative) */
  stockQty: number;
  /** Warn when stockQty <= lowStockThreshold (default 5) */
  lowStockThreshold: number;
  /** Archived products are hidden from active selling but kept for historical sales */
  isArchived: boolean;
  /** Marks optional sample/demo data so it can be clearly identified and removed */
  isDemo?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Sale {
  id: string;
  /** Unique client operation ID preventing accidental double-tap duplicate sales */
  operationId: string;
  /** Human-readable receipt reference, e.g. SB-20261023-001 */
  receiptNumber: string;
  paymentMethod: SalePaymentMethod;
  /** Optional manual note for Mobile Money (e.g. "Airtel Money", "MTN MoMo") */
  paymentReference: string | null;
  customerId: string | null;
  customerNameSnapshot: string | null;
  /** Sum of all saleItems lineTotalNgwee */
  totalNgwee: number;
  /** Total units sold across all items */
  totalUnits: number;
  /** Total cost of items where costPriceAtSaleNgwee was known */
  knownCostTotalNgwee: number;
  /** Revenue of items where costPriceAtSaleNgwee was known */
  knownCostRevenueNgwee: number;
  /** Number of line items sold without a known cost price */
  missingCostLineCount: number;
  /** Revenue of line items sold without a known cost price */
  missingCostRevenueNgwee: number;
  note: string;
  isDemo?: boolean;
  createdAt: string;
  /** Local business date YYYY-MM-DD in device timezone */
  localDate: string;
}

export interface SaleItem {
  id: string;
  saleId: string;
  productId: string;
  /** Snapshot of product name at the exact moment of sale */
  productNameAtSale: string;
  unitLabelAtSale: string;
  /** Snapshot of selling price (in ngwee) at the exact moment of sale */
  sellingPriceAtSaleNgwee: number;
  /** Snapshot of cost price (in ngwee) at the exact moment of sale, or null */
  costPriceAtSaleNgwee: number | null;
  quantity: number;
  lineTotalNgwee: number;
  isDemo?: boolean;
  createdAt: string;
}

export interface SaleWithItems extends Sale {
  items: SaleItem[];
}

export interface StockMovement {
  id: string;
  operationId: string;
  productId: string;
  productNameSnapshot: string;
  type: StockMovementType;
  /** Signed quantity change (+10 restock, -2 sale, etc.) */
  deltaQty: number;
  previousQty: number;
  newQty: number;
  reason: string;
  relatedSaleId: string | null;
  isDemo?: boolean;
  createdAt: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  notes: string;
  isDemo?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreditTransaction {
  id: string;
  /** Unique operation ID preventing duplicate repayments or credit charges */
  operationId: string;
  customerId: string;
  customerNameSnapshot: string;
  type: CreditTransactionType;
  /** Positive integer ngwee amount of the credit sale or repayment */
  amountNgwee: number;
  /** Present for repayments ('cash' | 'mobile_money'); null for credit_sale */
  paymentMethod: RepaymentPaymentMethod | null;
  relatedSaleId: string | null;
  note: string;
  isDemo?: boolean;
  createdAt: string;
  localDate: string;
}

export interface CustomerCreditSummary {
  customer: Customer;
  totalCreditNgwee: number;
  totalRepaidNgwee: number;
  /** Derived strictly from transactions: totalCreditNgwee - totalRepaidNgwee */
  outstandingBalanceNgwee: number;
  lastActivityAt: string;
}

export interface CustomerLedgerEntry extends CreditTransaction {
  /** Running debt balance immediately after this transaction */
  runningBalanceNgwee: number;
}

export interface BestSellingProductSummary {
  productId: string;
  productName: string;
  unitsSold: number;
  revenueNgwee: number;
}

export interface DailyTotalsRow {
  localDate: string;
  salesCount: number;
  totalSalesNgwee: number;
  cashSalesNgwee: number;
  mobileMoneySalesNgwee: number;
  creditSalesNgwee: number;
  repaymentsCashNgwee: number;
  repaymentsMobileMoneyNgwee: number;
  /** Immediate paid sales + debt repayments received on this date (never counts credit sales!) */
  totalMoneyReceivedNgwee: number;
}

export interface DaySummaryReport {
  localDate: string;
  salesCount: number;
  /** All sales recorded on localDate (cash + mobile_money + credit) */
  totalSalesRecordedNgwee: number;
  cashSalesNgwee: number;
  mobileMoneySalesNgwee: number;
  /** Credit sales recorded on localDate (goods given on credit — NOT cash received) */
  creditSalesNgwee: number;
  /** Debt repayments recorded on localDate (cash received — NOT a new sale) */
  repaymentsCashNgwee: number;
  repaymentsMobileMoneyNgwee: number;
  totalRepaymentsReceivedNgwee: number;
  /** Total Cash received = cashSalesNgwee + repaymentsCashNgwee */
  totalCashReceivedNgwee: number;
  /** Total Mobile Money manually recorded = mobileMoneySalesNgwee + repaymentsMobileMoneyNgwee */
  totalMobileMoneyReceivedNgwee: number;
  /** Combined Cash + Mobile Money received on localDate */
  totalMoneyReceivedNgwee: number;
  /** Current total outstanding debt owed across ALL customers */
  totalOutstandingCreditNgwee: number;
  customersOwingCount: number;
  /** Estimated gross profit from items sold on localDate that had a known cost price */
  estimatedGrossProfitNgwee: number | null;
  knownCostRevenueNgwee: number;
  knownCostTotalNgwee: number;
  missingCostLineCount: number;
  missingCostRevenueNgwee: number;
  bestSellingProducts: BestSellingProductSummary[];
  lowStockProducts: Product[];
}

export interface ShopBookBackupPayload {
  format: 'shopbook-backup-v1';
  exportedAt: string;
  shopSettings: ShopSettings;
  products: Product[];
  sales: Sale[];
  saleItems: SaleItem[];
  stockMovements: StockMovement[];
  customers: Customer[];
  creditTransactions: CreditTransaction[];
}
