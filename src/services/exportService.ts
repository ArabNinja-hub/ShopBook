import { runTransaction, STORES } from '../db/indexedDb';
import { ValidationError } from '../domain/errors';
import { assertValidNgwee, formatNgweePlain } from '../domain/money';
import {
  CreditTransaction,
  Customer,
  Product,
  Sale,
  SaleItem,
  ShopBookBackupPayload,
  ShopSettings,
  StockMovement,
} from '../domain/types';
import { computeCustomerTotalsFromTransactions } from './creditService';

/**
 * Escapes a single CSV cell per RFC 4180 and neutralizes spreadsheet formula
 * injection on user-supplied text fields (`=`, `+`, `-`, `@` at start of string).
 */
export function escapeCsvCell(
  value: string | number | boolean | null | undefined,
  options: { isNumeric?: boolean } = {}
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  let str = value;
  if (!options.isNumeric && /^[=+\-@]/.test(str.trimStart())) {
    str = `'${str}`;
  }

  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsvDocument(
  headers: string[],
  rows: Array<Array<{ value: string | number | boolean | null | undefined; isNumeric?: boolean }>>
): string {
  const headerLine = headers.map((h) => escapeCsvCell(h)).join(',');
  const bodyLines = rows.map((row) =>
    row.map((cell) => escapeCsvCell(cell.value, { isNumeric: cell.isNumeric })).join(',')
  );
  return [headerLine, ...bodyLines].join('\r\n') + '\r\n';
}

/**
 * Exports all products (active and archived) to CSV.
 */
export async function exportProductsCsv(): Promise<string> {
  const products = await runTransaction([STORES.products], 'readonly', (ctx) =>
    ctx.getAll(STORES.products)
  );
  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name));

  return buildCsvDocument(
    [
      'Product ID',
      'Product Name',
      'Unit',
      'Selling Price (ZMW)',
      'Cost Price (ZMW)',
      'Stock Quantity',
      'Low Stock Threshold',
      'Low Stock Flag',
      'Status',
      'Updated At',
    ],
    sorted.map((p) => [
      { value: p.id },
      { value: p.name },
      { value: p.unitLabel },
      { value: formatNgweePlain(p.sellingPriceNgwee), isNumeric: true },
      {
        value: p.costPriceNgwee !== null ? formatNgweePlain(p.costPriceNgwee) : '',
        isNumeric: true,
      },
      { value: p.stockQty, isNumeric: true },
      { value: p.lowStockThreshold, isNumeric: true },
      { value: !p.isArchived && p.stockQty <= p.lowStockThreshold ? 'LOW' : 'OK' },
      { value: p.isArchived ? 'Archived' : 'Active' },
      { value: p.updatedAt },
    ])
  );
}

/**
 * Exports all recorded sales (summary per receipt) to CSV.
 */
export async function exportSalesCsv(): Promise<string> {
  const [sales, saleItems] = await runTransaction(
    [STORES.sales, STORES.saleItems],
    'readonly',
    (ctx) => Promise.all([ctx.getAll(STORES.sales), ctx.getAll(STORES.saleItems)])
  );

  const itemsBySale = new Map<string, SaleItem[]>();
  for (const item of saleItems) {
    const list = itemsBySale.get(item.saleId);
    if (list) list.push(item);
    else itemsBySale.set(item.saleId, [item]);
  }

  const sorted = [...sales].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return buildCsvDocument(
    [
      'Receipt Number',
      'Sale ID',
      'Local Date',
      'Timestamp (ISO)',
      'Payment Method',
      'Payment Reference',
      'Customer Name',
      'Total Units',
      'Total Sale (ZMW)',
      'Known Cost Total (ZMW)',
      'Missing Cost Lines',
      'Items Sold',
      'Note',
    ],
    sorted.map((s) => {
      const itemsSummary = (itemsBySale.get(s.id) ?? [])
        .map(
          (i) =>
            `${i.quantity}x ${i.productNameAtSale} @ K${formatNgweePlain(i.sellingPriceAtSaleNgwee)}`
        )
        .join('; ');
      return [
        { value: s.receiptNumber },
        { value: s.id },
        { value: s.localDate },
        { value: s.createdAt },
        { value: s.paymentMethod },
        { value: s.paymentReference ?? '' },
        { value: s.customerNameSnapshot ?? '' },
        { value: s.totalUnits, isNumeric: true },
        { value: formatNgweePlain(s.totalNgwee), isNumeric: true },
        { value: formatNgweePlain(s.knownCostTotalNgwee), isNumeric: true },
        { value: s.missingCostLineCount, isNumeric: true },
        { value: itemsSummary },
        { value: s.note },
      ];
    })
  );
}

/**
 * Exports all line-by-line historical SaleItem snapshots to CSV.
 */
export async function exportSaleItemsCsv(): Promise<string> {
  const [sales, saleItems] = await runTransaction(
    [STORES.sales, STORES.saleItems],
    'readonly',
    (ctx) => Promise.all([ctx.getAll(STORES.sales), ctx.getAll(STORES.saleItems)])
  );

  const saleMap = new Map(sales.map((s) => [s.id, s]));
  const sorted = [...saleItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return buildCsvDocument(
    [
      'Receipt Number',
      'Local Date',
      'Timestamp (ISO)',
      'Payment Method',
      'Product ID',
      'Product Name At Sale',
      'Unit At Sale',
      'Quantity',
      'Selling Price At Sale (ZMW)',
      'Cost Price At Sale (ZMW)',
      'Line Total (ZMW)',
    ],
    sorted.map((item) => {
      const parent = saleMap.get(item.saleId);
      return [
        { value: parent?.receiptNumber ?? item.saleId },
        { value: parent?.localDate ?? '' },
        { value: item.createdAt },
        { value: parent?.paymentMethod ?? '' },
        { value: item.productId },
        { value: item.productNameAtSale },
        { value: item.unitLabelAtSale },
        { value: item.quantity, isNumeric: true },
        { value: formatNgweePlain(item.sellingPriceAtSaleNgwee), isNumeric: true },
        {
          value:
            item.costPriceAtSaleNgwee !== null
              ? formatNgweePlain(item.costPriceAtSaleNgwee)
              : '',
          isNumeric: true,
        },
        { value: formatNgweePlain(item.lineTotalNgwee), isNumeric: true },
      ];
    })
  );
}

/**
 * Exports all customers and their transaction-derived credit balances to CSV.
 */
export async function exportCustomerBalancesCsv(): Promise<string> {
  const [customers, creditTxs] = await runTransaction(
    [STORES.customers, STORES.creditTransactions],
    'readonly',
    (ctx) =>
      Promise.all([
        ctx.getAll(STORES.customers),
        ctx.getAll(STORES.creditTransactions),
      ])
  );

  const txByCustomer = new Map<string, CreditTransaction[]>();
  for (const tx of creditTxs) {
    const list = txByCustomer.get(tx.customerId);
    if (list) list.push(tx);
    else txByCustomer.set(tx.customerId, [tx]);
  }

  const rows = customers
    .map((c) => ({
      customer: c,
      totals: computeCustomerTotalsFromTransactions(txByCustomer.get(c.id) ?? []),
    }))
    .sort((a, b) => b.totals.outstandingBalanceNgwee - a.totals.outstandingBalanceNgwee);

  return buildCsvDocument(
    [
      'Customer ID',
      'Customer Name',
      'Phone',
      'Total Credit Taken (ZMW)',
      'Total Repaid (ZMW)',
      'Outstanding Balance (ZMW)',
      'Notes',
    ],
    rows.map(({ customer, totals }) => [
      { value: customer.id },
      { value: customer.name },
      { value: customer.phone },
      { value: formatNgweePlain(totals.totalCreditNgwee), isNumeric: true },
      { value: formatNgweePlain(totals.totalRepaidNgwee), isNumeric: true },
      { value: formatNgweePlain(totals.outstandingBalanceNgwee), isNumeric: true },
      { value: customer.notes },
    ])
  );
}

/**
 * Exports the full credit & repayment transaction history across all customers to CSV.
 */
export async function exportCreditTransactionsCsv(): Promise<string> {
  const creditTxs = await runTransaction(
    [STORES.creditTransactions],
    'readonly',
    (ctx) => ctx.getAll(STORES.creditTransactions)
  );

  const sorted = [...creditTxs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return buildCsvDocument(
    [
      'Transaction ID',
      'Local Date',
      'Timestamp (ISO)',
      'Customer ID',
      'Customer Name',
      'Type',
      'Amount (ZMW)',
      'Signed Balance Effect (ZMW)',
      'Payment Method',
      'Related Sale ID',
      'Note',
    ],
    sorted.map((tx) => [
      { value: tx.id },
      { value: tx.localDate },
      { value: tx.createdAt },
      { value: tx.customerId },
      { value: tx.customerNameSnapshot },
      { value: tx.type },
      { value: formatNgweePlain(tx.amountNgwee), isNumeric: true },
      {
        value: formatNgweePlain(
          tx.type === 'credit_sale' ? tx.amountNgwee : -tx.amountNgwee
        ),
        isNumeric: true,
      },
      { value: tx.paymentMethod ?? '' },
      { value: tx.relatedSaleId ?? '' },
      { value: tx.note },
    ])
  );
}

/**
 * Creates a complete structured JSON backup of all local ShopBook stores
 * and updates `lastBackupAt` in shopSettings.
 */
export async function createFullBackupJson(now: Date = new Date()): Promise<string> {
  const exportedAt = now.toISOString();

  const payload = await runTransaction(
    [
      STORES.meta,
      STORES.products,
      STORES.sales,
      STORES.saleItems,
      STORES.stockMovements,
      STORES.customers,
      STORES.creditTransactions,
    ],
    'readwrite',
    async (ctx) => {
      const existingSettings = await ctx.get(STORES.meta, 'shopSettings');
      const shopSettings: ShopSettings = {
        key: 'shopSettings',
        shopName: existingSettings?.shopName ?? 'My Shop',
        hasDemoData: existingSettings?.hasDemoData ?? false,
        lastBackupAt: exportedAt,
        createdAt: existingSettings?.createdAt ?? exportedAt,
        updatedAt: exportedAt,
      };
      await ctx.put(STORES.meta, shopSettings);

      const [
        products,
        sales,
        saleItems,
        stockMovements,
        customers,
        creditTransactions,
      ] = await Promise.all([
        ctx.getAll(STORES.products),
        ctx.getAll(STORES.sales),
        ctx.getAll(STORES.saleItems),
        ctx.getAll(STORES.stockMovements),
        ctx.getAll(STORES.customers),
        ctx.getAll(STORES.creditTransactions),
      ]);

      const backup: ShopBookBackupPayload = {
        format: 'shopbook-backup-v1',
        exportedAt,
        shopSettings,
        products,
        sales,
        saleItems,
        stockMovements,
        customers,
        creditTransactions,
      };
      return backup;
    }
  );

  return JSON.stringify(payload, null, 2);
}

/**
 * Validates and restores a complete ShopBook JSON backup atomically.
 * All validation runs BEFORE touching the database so an invalid file never corrupts records.
 */
export async function restoreBackupFromJson(rawJson: string): Promise<{
  productsCount: number;
  salesCount: number;
  customersCount: number;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new ValidationError('Invalid backup file: could not parse JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ValidationError('Invalid backup file structure.');
  }

  const data = parsed as Partial<ShopBookBackupPayload>;
  if (data.format !== 'shopbook-backup-v1') {
    throw new ValidationError(
      'Unsupported backup format. Please select a valid ShopBook v1 JSON backup file.'
    );
  }

  if (
    !Array.isArray(data.products) ||
    !Array.isArray(data.sales) ||
    !Array.isArray(data.saleItems) ||
    !Array.isArray(data.stockMovements) ||
    !Array.isArray(data.customers) ||
    !Array.isArray(data.creditTransactions)
  ) {
    throw new ValidationError('Backup file is missing one or more required record tables.');
  }

  const isLocalDate = (val: unknown): val is string =>
    typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);

  // Validate customers first so sales and creditTransactions can check customer references
  const customerIds = new Set<string>();
  for (const c of data.customers as Customer[]) {
    if (!c?.id || typeof c.id !== 'string' || typeof c.name !== 'string' || !c.name.trim()) {
      throw new ValidationError('Backup contains an invalid customer record.');
    }
    if (customerIds.has(c.id)) {
      throw new ValidationError(`Backup contains duplicate customer ID "${c.id}".`);
    }
    customerIds.add(c.id);
  }

  // Validate products
  const productIds = new Set<string>();
  for (const p of data.products as Product[]) {
    if (!p?.id || typeof p.id !== 'string' || typeof p.name !== 'string' || !p.name.trim()) {
      throw new ValidationError('Backup contains an invalid product record.');
    }
    if (productIds.has(p.id)) {
      throw new ValidationError(`Backup contains duplicate product ID "${p.id}".`);
    }
    productIds.add(p.id);
    assertValidNgwee(p.sellingPriceNgwee, `Selling price for ${p.name}`, false);
    if (p.costPriceNgwee !== null && p.costPriceNgwee !== undefined) {
      assertValidNgwee(p.costPriceNgwee, `Cost price for ${p.name}`, true);
    }
    if (!Number.isSafeInteger(p.stockQty) || p.stockQty < 0) {
      throw new ValidationError(`Backup contains negative or invalid stock for ${p.name}.`);
    }
    if (!Number.isSafeInteger(p.lowStockThreshold) || p.lowStockThreshold < 0) {
      throw new ValidationError(`Backup contains an invalid low-stock threshold for ${p.name}.`);
    }
    if (typeof p.isArchived !== 'boolean') {
      throw new ValidationError(`Backup contains an invalid archive flag for ${p.name}.`);
    }
  }

  // Validate sales & saleItems
  const saleIds = new Set<string>();
  const saleOpIds = new Set<string>();
  const expectedSaleTotalById = new Map<string, number>();

  for (const s of data.sales as Sale[]) {
    if (!s?.id || typeof s.id !== 'string' || !s?.operationId || typeof s.operationId !== 'string') {
      throw new ValidationError('Backup contains a sale missing ID or operationId.');
    }
    if (saleIds.has(s.id)) {
      throw new ValidationError(`Backup contains duplicate sale ID "${s.id}".`);
    }
    if (saleOpIds.has(s.operationId)) {
      throw new ValidationError(`Backup contains duplicate sale operationId "${s.operationId}".`);
    }
    if (!['cash', 'mobile_money', 'credit'].includes(s.paymentMethod)) {
      throw new ValidationError(`Backup contains invalid payment method on sale ${s.receiptNumber}.`);
    }
    if (!isLocalDate(s.localDate)) {
      throw new ValidationError(`Backup contains invalid localDate on sale ${s.receiptNumber}.`);
    }
    if (s.paymentMethod === 'credit' && (!s.customerId || !customerIds.has(s.customerId))) {
      throw new ValidationError(
        `Backup contains credit sale ${s.receiptNumber} referencing a missing customer.`
      );
    }
    if (!Number.isSafeInteger(s.totalUnits) || s.totalUnits <= 0) {
      throw new ValidationError(`Backup contains invalid unit count on sale ${s.receiptNumber}.`);
    }
    assertValidNgwee(s.totalNgwee, `Sale ${s.receiptNumber}`, false);
    assertValidNgwee(s.knownCostTotalNgwee ?? 0, `Known cost on ${s.receiptNumber}`, true);
    assertValidNgwee(s.knownCostRevenueNgwee ?? 0, `Known-cost revenue on ${s.receiptNumber}`, true);
    assertValidNgwee(s.missingCostRevenueNgwee ?? 0, `Missing-cost revenue on ${s.receiptNumber}`, true);

    saleIds.add(s.id);
    saleOpIds.add(s.operationId);
    expectedSaleTotalById.set(s.id, s.totalNgwee);
  }

  const saleItemIds = new Set<string>();
  const actualItemsSumBySaleId = new Map<string, number>();
  for (const item of data.saleItems as SaleItem[]) {
    if (!item?.id || typeof item.id !== 'string' || !saleIds.has(item.saleId)) {
      throw new ValidationError('Backup contains an orphaned or invalid sale item record.');
    }
    if (saleItemIds.has(item.id)) {
      throw new ValidationError(`Backup contains duplicate sale item ID "${item.id}".`);
    }
    saleItemIds.add(item.id);
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw new ValidationError('Backup contains a sale item with invalid quantity.');
    }
    assertValidNgwee(item.sellingPriceAtSaleNgwee, 'Sale item unit price', false);
    if (item.costPriceAtSaleNgwee !== null && item.costPriceAtSaleNgwee !== undefined) {
      assertValidNgwee(item.costPriceAtSaleNgwee, 'Sale item cost price', true);
    }
    assertValidNgwee(item.lineTotalNgwee, 'Sale item total', false);
    if (item.lineTotalNgwee !== item.sellingPriceAtSaleNgwee * item.quantity) {
      throw new ValidationError('Backup contains a sale item whose line total does not match price × quantity.');
    }
    actualItemsSumBySaleId.set(
      item.saleId,
      (actualItemsSumBySaleId.get(item.saleId) ?? 0) + item.lineTotalNgwee
    );
  }

  for (const [saleId, expectedTotal] of expectedSaleTotalById.entries()) {
    const itemsSum = actualItemsSumBySaleId.get(saleId) ?? 0;
    if (itemsSum !== expectedTotal) {
      throw new ValidationError(
        `Backup sale "${saleId}" total does not match the sum of its sale items.`
      );
    }
  }

  const moveIds = new Set<string>();
  const moveOpIds = new Set<string>();
  for (const move of data.stockMovements as StockMovement[]) {
    if (
      !move?.id ||
      typeof move.id !== 'string' ||
      !move?.operationId ||
      typeof move.operationId !== 'string' ||
      !move?.productId ||
      !Number.isSafeInteger(move.newQty) ||
      move.newQty < 0 ||
      !Number.isSafeInteger(move.previousQty) ||
      move.previousQty < 0 ||
      !Number.isSafeInteger(move.deltaQty)
    ) {
      throw new ValidationError('Backup contains an invalid stock movement record.');
    }
    if (moveIds.has(move.id) || moveOpIds.has(move.operationId)) {
      throw new ValidationError('Backup contains duplicate stock movement IDs or operationIds.');
    }
    moveIds.add(move.id);
    moveOpIds.add(move.operationId);
  }

  const creditIds = new Set<string>();
  const creditOpIds = new Set<string>();
  const creditByCustomer = new Map<string, CreditTransaction[]>();
  for (const tx of data.creditTransactions as CreditTransaction[]) {
    if (
      !tx?.id ||
      typeof tx.id !== 'string' ||
      !tx?.operationId ||
      typeof tx.operationId !== 'string' ||
      !customerIds.has(tx.customerId)
    ) {
      throw new ValidationError('Backup contains an invalid credit transaction.');
    }
    if (creditIds.has(tx.id) || creditOpIds.has(tx.operationId)) {
      throw new ValidationError('Backup contains duplicate credit transaction IDs or operationIds.');
    }
    if (tx.type !== 'credit_sale' && tx.type !== 'repayment') {
      throw new ValidationError('Backup contains an unknown credit transaction type.');
    }
    if (
      tx.type === 'repayment' &&
      tx.paymentMethod !== 'cash' &&
      tx.paymentMethod !== 'mobile_money'
    ) {
      throw new ValidationError('Backup contains a repayment without a valid payment method.');
    }
    if (!isLocalDate(tx.localDate)) {
      throw new ValidationError('Backup contains a credit transaction with an invalid localDate.');
    }
    assertValidNgwee(tx.amountNgwee, 'Credit transaction amount', false);
    creditIds.add(tx.id);
    creditOpIds.add(tx.operationId);

    const list = creditByCustomer.get(tx.customerId);
    if (list) list.push(tx);
    else creditByCustomer.set(tx.customerId, [tx]);
  }

  for (const [custId, txs] of creditByCustomer.entries()) {
    const chronological = [...txs].sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp !== 0) return cmp;
      if (a.type !== b.type) return a.type === 'credit_sale' ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    let running = 0;
    for (const tx of chronological) {
      running += tx.type === 'credit_sale' ? tx.amountNgwee : -tx.amountNgwee;
      if (running < 0) {
        throw new ValidationError(
          `Backup has an inconsistent negative running credit balance for customer ${custId}.`
        );
      }
    }
    const totals = computeCustomerTotalsFromTransactions(txs);
    if (totals.outstandingBalanceNgwee < 0) {
      throw new ValidationError(
        `Backup has an inconsistent negative credit balance for customer ${custId}.`
      );
    }
  }

  const nowIso = new Date().toISOString();
  const settings: ShopSettings = {
    key: 'shopSettings',
    shopName: data.shopSettings?.shopName?.trim() || 'My Shop',
    hasDemoData: Boolean(data.shopSettings?.hasDemoData),
    lastBackupAt: data.exportedAt || nowIso,
    createdAt: data.shopSettings?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  // Atomically replace all stores inside a single readwrite transaction
  await runTransaction(
    [
      STORES.meta,
      STORES.products,
      STORES.sales,
      STORES.saleItems,
      STORES.stockMovements,
      STORES.customers,
      STORES.creditTransactions,
      STORES.syncOutbox,
    ],
    'readwrite',
    async (ctx) => {
      await ctx.clear(STORES.meta);
      await ctx.clear(STORES.products);
      await ctx.clear(STORES.sales);
      await ctx.clear(STORES.saleItems);
      await ctx.clear(STORES.stockMovements);
      await ctx.clear(STORES.customers);
      await ctx.clear(STORES.creditTransactions);
      await ctx.clear(STORES.syncOutbox);

      await ctx.put(STORES.meta, settings);
      for (const p of data.products!) await ctx.add(STORES.products, p);
      for (const s of data.sales!) await ctx.add(STORES.sales, s);
      for (const i of data.saleItems!) await ctx.add(STORES.saleItems, i);
      for (const m of data.stockMovements!) await ctx.add(STORES.stockMovements, m);
      for (const c of data.customers!) await ctx.add(STORES.customers, c);
      for (const t of data.creditTransactions!) {
        await ctx.add(STORES.creditTransactions, t);
      }
    }
  );

  return {
    productsCount: data.products.length,
    salesCount: data.sales.length,
    customersCount: data.customers.length,
  };
}

/**
 * Triggers a client-side file download in mobile and desktop browsers.
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
