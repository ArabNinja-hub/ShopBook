import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeShopDatabase, resetDatabaseForTests } from '../db/indexedDb';
import {
  DuplicateOperationError,
  InsufficientStockError,
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import { createId } from '../domain/ids';
import {
  adjustProductStock,
  createProduct,
  listProducts,
  setProductArchived,
  updateProduct,
} from '../services/stockService';
import { listSalesWithItems, recordSale } from '../services/salesService';
import {
  createCustomer,
  getCustomerStatement,
  listCustomersWithBalances,
  recordRepayment,
} from '../services/creditService';
import { getDailyTotalsHistory, getDaySummary } from '../services/summaryService';
import {
  createFullBackupJson,
  escapeCsvCell,
  exportCreditTransactionsCsv,
  exportCustomerBalancesCsv,
  exportProductsCsv,
  exportSaleItemsCsv,
  exportSalesCsv,
  restoreBackupFromJson,
} from '../services/exportService';
import {
  getShopSettings,
  loadSampleDemoData,
  removeDemoData,
  updateShopName,
} from '../services/shopService';

describe('ShopBook local operations (IndexedDB ACID transactions)', () => {
  const fixedToday = new Date('2026-10-23T10:30:00');
  const fixedDateKey = '2026-10-23';

  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('creates products, flags low stock, adjusts stock, and prevents negative stock', async () => {
    const oil = await createProduct({
      name: 'Cooking Oil 2L',
      unitLabel: '2L bottle',
      sellingPriceNgwee: 9200,
      costPriceNgwee: 7800,
      initialStockQty: 4,
      lowStockThreshold: 5,
      now: fixedToday,
    });

    expect(oil.stockQty).toBe(4);

    // Reject subtracting more than available stock
    await expect(
      adjustProductStock({
        operationId: createId('op'),
        productId: oil.id,
        mode: 'subtract',
        quantity: 6,
        reason: 'Damaged',
      })
    ).rejects.toThrow(ValidationError);

    // Verify stock remained untouched at 4
    const afterFailed = await listProducts();
    expect(afterFailed[0].stockQty).toBe(4);

    // Restock +10 units
    const restocked = await adjustProductStock({
      operationId: createId('op'),
      productId: oil.id,
      mode: 'add',
      quantity: 10,
      reason: 'New supplier delivery',
    });
    expect(restocked.product.stockQty).toBe(14);
  });

  it('records sales atomically, rolls back completely on insufficient stock, and blocks double-taps', async () => {
    const bread = await createProduct({
      name: 'White Bread',
      unitLabel: 'loaf',
      sellingPriceNgwee: 2250,
      costPriceNgwee: 1850,
      initialStockQty: 5,
      now: fixedToday,
    });

    const sugar = await createProduct({
      name: 'Sugar 2kg',
      unitLabel: 'pack',
      sellingPriceNgwee: 6800,
      costPriceNgwee: 5900,
      initialStockQty: 2,
      now: fixedToday,
    });

    // Attempt multi-item sale where second item exceeds available stock (requests 3 sugar, only 2 in stock)
    await expect(
      recordSale({
        operationId: createId('op'),
        paymentMethod: 'cash',
        items: [
          { productId: bread.id, quantity: 2 },
          { productId: sugar.id, quantity: 3 },
        ],
        now: fixedToday,
      })
    ).rejects.toThrow(InsufficientStockError);

    // CRITICAL ATOMICITY CHECK: Bread stock MUST still be 5 and zero sales recorded
    const productsAfterRollback = await listProducts();
    expect(productsAfterRollback.find((p) => p.id === bread.id)?.stockQty).toBe(5);
    expect(productsAfterRollback.find((p) => p.id === sugar.id)?.stockQty).toBe(2);
    expect(await listSalesWithItems()).toHaveLength(0);

    // Valid sale succeeds and deducts stock
    const opId = createId('op');
    const sale = await recordSale({
      operationId: opId,
      paymentMethod: 'cash',
      items: [
        { productId: bread.id, quantity: 2 },
        { productId: sugar.id, quantity: 1 },
      ],
      now: fixedToday,
    });

    // 2 * 2250 + 1 * 6800 = 11300 (K113.00)
    expect(sale.totalNgwee).toBe(11300);

    // Double-tap with identical operationId is rejected and does NOT deduct stock again
    await expect(
      recordSale({
        operationId: opId,
        paymentMethod: 'cash',
        items: [{ productId: bread.id, quantity: 2 }],
        now: fixedToday,
      })
    ).rejects.toThrow(DuplicateOperationError);

    const productsAfterSale = await listProducts();
    expect(productsAfterSale.find((p) => p.id === bread.id)?.stockQty).toBe(3);
    expect(productsAfterSale.find((p) => p.id === sugar.id)?.stockQty).toBe(1);
  });

  it('preserves product name, selling price, and cost price snapshots even after product edits or archiving', async () => {
    const soap = await createProduct({
      name: 'Bath Soap Original',
      unitLabel: 'bar',
      sellingPriceNgwee: 1800,
      costPriceNgwee: 1350,
      initialStockQty: 10,
      now: fixedToday,
    });

    await recordSale({
      operationId: createId('op'),
      paymentMethod: 'mobile_money',
      paymentReference: 'Airtel Money',
      items: [{ productId: soap.id, quantity: 3 }],
      now: fixedToday,
    });

    // Later edit product name & prices AND archive it
    await updateProduct(soap.id, {
      name: 'Bath Soap New Formula',
      unitLabel: 'large bar',
      sellingPriceNgwee: 2500,
      costPriceNgwee: 2000,
      lowStockThreshold: 5,
    });
    await setProductArchived(soap.id, true);

    // Active product list hides archived item
    expect(await listProducts({ includeArchived: false })).toHaveLength(0);
    expect(await listProducts({ includeArchived: true })).toHaveLength(1);

    // Historical sale MUST retain original name, K18.00 selling price, and K13.50 cost price
    const sales = await listSalesWithItems();
    expect(sales).toHaveLength(1);
    expect(sales[0].totalNgwee).toBe(5400);
    expect(sales[0].items[0].productNameAtSale).toBe('Bath Soap Original');
    expect(sales[0].items[0].sellingPriceAtSaleNgwee).toBe(1800);
    expect(sales[0].items[0].costPriceAtSaleNgwee).toBe(1350);
  });

  it('manages customer credit balances strictly from transactions and separates credit vs cash in daily summaries', async () => {
    const mealieMeal = await createProduct({
      name: 'Breakfast Meal 25kg',
      unitLabel: 'bag',
      sellingPriceNgwee: 31000, // K310.00
      costPriceNgwee: 28000, // K280.00 -> K30.00 gross profit
      initialStockQty: 10,
      now: fixedToday,
    });

    const talktimeNoCost = await createProduct({
      name: 'Airtime K20',
      unitLabel: 'pin',
      sellingPriceNgwee: 2000, // K20.00
      costPriceNgwee: null, // Unknown cost price
      initialStockQty: 15,
      now: fixedToday,
    });

    const customer = await createCustomer({
      name: 'Banda Phiri',
      phone: '0977123456',
      now: fixedToday,
    });

    // 1. Cash sale: 1x Airtime K20 (K20.00 cash received, missing cost price)
    await recordSale({
      operationId: createId('op'),
      paymentMethod: 'cash',
      items: [{ productId: talktimeNoCost.id, quantity: 1 }],
      now: fixedToday,
    });

    // 2. Credit sale to Banda Phiri: 1x Breakfast Meal (K310.00 credit — NOT cash received!)
    await recordSale({
      operationId: createId('op'),
      paymentMethod: 'credit',
      customerId: customer.id,
      items: [{ productId: mealieMeal.id, quantity: 1 }],
      now: fixedToday,
    });

    // 3. Partial repayment from Banda Phiri: K100.00 via Mobile Money (money received — NOT a new sale!)
    const repayOpId = createId('op');
    await recordRepayment({
      operationId: repayOpId,
      customerId: customer.id,
      amountNgwee: 10000, // K100.00
      paymentMethod: 'mobile_money',
      note: 'MTN MoMo received',
      now: fixedToday,
    });

    // Duplicate repayment with same operationId is blocked
    await expect(
      recordRepayment({
        operationId: repayOpId,
        customerId: customer.id,
        amountNgwee: 10000,
        paymentMethod: 'mobile_money',
        now: fixedToday,
      })
    ).rejects.toThrow(DuplicateOperationError);

    // Over-repayment (> remaining K210.00 balance) is blocked
    await expect(
      recordRepayment({
        operationId: createId('op'),
        customerId: customer.id,
        amountNgwee: 25000, // K250.00 > K210.00 owing
        paymentMethod: 'cash',
        now: fixedToday,
      })
    ).rejects.toThrow(ValidationError);

    // Verify customer balance & running statement
    const statement = await getCustomerStatement(customer.id);
    expect(statement.summary.totalCreditNgwee).toBe(31000);
    expect(statement.summary.totalRepaidNgwee).toBe(10000);
    expect(statement.summary.outstandingBalanceNgwee).toBe(21000); // K210.00 owing
    expect(statement.entries).toHaveLength(2);
    expect(statement.entries[0].runningBalanceNgwee).toBe(21000); // latest entry

    // Verify Today Summary accounting rules (zero double-counting!)
    const summary = await getDaySummary(fixedDateKey);
    expect(summary.salesCount).toBe(2);
    // Total Sales Recorded = K20.00 cash sale + K310.00 credit sale = K330.00 (repayment NOT counted as sale!)
    expect(summary.totalSalesRecordedNgwee).toBe(33000);
    expect(summary.cashSalesNgwee).toBe(2000);
    expect(summary.creditSalesNgwee).toBe(31000);

    // Money Received = K20.00 cash sale + K100.00 MoMo repayment = K120.00 (credit sale NOT counted as cash!)
    expect(summary.repaymentsMobileMoneyNgwee).toBe(10000);
    expect(summary.totalCashReceivedNgwee).toBe(2000);
    expect(summary.totalMobileMoneyReceivedNgwee).toBe(10000);
    expect(summary.totalMoneyReceivedNgwee).toBe(12000);

    // Outstanding credit across shop = K210.00
    expect(summary.totalOutstandingCreditNgwee).toBe(21000);
    expect(summary.customersOwingCount).toBe(1);

    // Estimated gross profit = K30.00 on Mealie Meal, while flagging 1 line item (K20.00) missing cost price
    expect(summary.estimatedGrossProfitNgwee).toBe(3000);
    expect(summary.missingCostLineCount).toBe(1);
    expect(summary.missingCostRevenueNgwee).toBe(2000);

    const history = await getDailyTotalsHistory();
    expect(history).toHaveLength(1);
    expect(history[0].totalSalesNgwee).toBe(33000);
    expect(history[0].totalMoneyReceivedNgwee).toBe(12000);
  });

  it('exports valid CSVs, performs full JSON backup & restore, and cleanly removes demo data', async () => {
    await loadSampleDemoData(fixedToday);
    expect((await listProducts()).length).toBeGreaterThan(0);

    const productsCsv = await exportProductsCsv();
    const salesCsv = await exportSalesCsv();
    const customersCsv = await exportCustomerBalancesCsv();

    expect(productsCsv).toContain('Selling Price (ZMW)');
    expect(salesCsv).toContain('Receipt Number');
    expect(customersCsv).toContain('Outstanding Balance (ZMW)');

    const backupJson = await createFullBackupJson(fixedToday);

    // Remove demo data leaves clean empty shop
    await removeDemoData();
    expect(await listProducts({ includeArchived: true })).toHaveLength(0);
    expect(await listCustomersWithBalances()).toHaveLength(0);

    // Restore from JSON backup brings records back accurately
    const restored = await restoreBackupFromJson(backupJson);
    expect(restored.productsCount).toBe(6);
    expect(restored.salesCount).toBe(2);
    expect(restored.customersCount).toBe(1);

    // Additional CSV exports include sale items and credit history
    const saleItemsCsv = await exportSaleItemsCsv();
    const creditHistoryCsv = await exportCreditTransactionsCsv();
    expect(saleItemsCsv).toContain('Selling Price At Sale (ZMW)');
    expect(creditHistoryCsv).toContain('Signed Balance Effect (ZMW)');
  });

  it('rejects corrupted or invalid JSON backups without wiping existing shop records', async () => {
    const prod = await createProduct({
      name: 'Maize Meal 10kg',
      sellingPriceNgwee: 14500,
      costPriceNgwee: 12000,
      initialStockQty: 7,
      now: fixedToday,
    });

    await expect(restoreBackupFromJson('{invalid json')).rejects.toThrow(
      ValidationError
    );

    const badBackup = JSON.stringify({
      format: 'shopbook-backup-v1',
      exportedAt: fixedToday.toISOString(),
      products: [
        {
          ...prod,
          stockQty: -3, // Invalid negative stock
        },
      ],
      sales: [],
      saleItems: [],
      stockMovements: [],
      customers: [],
      creditTransactions: [],
    });

    await expect(restoreBackupFromJson(badBackup)).rejects.toThrow(
      ValidationError
    );

    // Existing product record is still intact
    const remaining = await listProducts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].stockQty).toBe(7);
  });

  it('blocks selling archived products, handles all-missing cost prices honestly, and neutralizes CSV formula injection', async () => {
    const item = await createProduct({
      name: '=DANGEROUS_FORMULA_NAME',
      sellingPriceNgwee: 1500,
      costPriceNgwee: null,
      initialStockQty: 5,
      now: fixedToday,
    });

    await recordSale({
      operationId: createId('op'),
      paymentMethod: 'cash',
      items: [{ productId: item.id, quantity: 2 }],
      now: fixedToday,
    });

    // Since zero sold items had a cost price, estimatedGrossProfitNgwee is null (not misleading 0)
    const daySummary = await getDaySummary(fixedDateKey);
    expect(daySummary.estimatedGrossProfitNgwee).toBeNull();
    expect(daySummary.missingCostLineCount).toBe(1);
    expect(daySummary.missingCostRevenueNgwee).toBe(3000);

    // Archive item and verify new sales are blocked
    await setProductArchived(item.id, true);
    await expect(
      recordSale({
        operationId: createId('op'),
        paymentMethod: 'cash',
        items: [{ productId: item.id, quantity: 1 }],
        now: fixedToday,
      })
    ).rejects.toThrow(ValidationError);

    // CSV cell neutralization prefixes user text starting with '='
    expect(escapeCsvCell('=SUM(A1:A5)')).toBe("'=SUM(A1:A5)");
    expect(escapeCsvCell('-20.00', { isNumeric: true })).toBe('-20.00');
  });

  it('preserves all shop records across database close & reopen (simulated browser refresh) and rolls back failed credit sales completely', async () => {
    await updateShopName('Chifubu Corner Store');
    const flour = await createProduct({
      name: 'Cake Flour 2.5kg',
      unitLabel: 'pack',
      sellingPriceNgwee: 5500,
      costPriceNgwee: 4600,
      initialStockQty: 6,
      now: fixedToday,
    });
    const cust = await createCustomer({
      name: 'Mutale Sampa',
      phone: '0966112233',
      now: fixedToday,
    });

    // Credit sale referencing nonexistent customer fails and leaves stock untouched at 6
    await expect(
      recordSale({
        operationId: createId('op'),
        paymentMethod: 'credit',
        customerId: 'cus_does_not_exist',
        items: [{ productId: flour.id, quantity: 2 }],
        now: fixedToday,
      })
    ).rejects.toThrow(NotFoundError);
    expect((await listProducts())[0].stockQty).toBe(6);

    // Valid credit sale + partial repayment
    await recordSale({
      operationId: createId('op'),
      paymentMethod: 'credit',
      customerId: cust.id,
      items: [{ productId: flour.id, quantity: 2 }], // K110.00
      now: fixedToday,
    });
    await recordRepayment({
      operationId: createId('op'),
      customerId: cust.id,
      amountNgwee: 4000, // K40.00 cash repayment -> K70.00 owing
      paymentMethod: 'cash',
      now: fixedToday,
    });

    // Simulate browser tab refresh: close IDBDatabase connection without deleting storage
    await closeShopDatabase();

    // Re-read everything from fresh connection
    const settingsAfterRefresh = await getShopSettings();
    expect(settingsAfterRefresh.shopName).toBe('Chifubu Corner Store');

    const productsAfterRefresh = await listProducts();
    expect(productsAfterRefresh).toHaveLength(1);
    expect(productsAfterRefresh[0].stockQty).toBe(4);

    const statementAfterRefresh = await getCustomerStatement(cust.id);
    expect(statementAfterRefresh.summary.outstandingBalanceNgwee).toBe(7000);

    const summaryAfterRefresh = await getDaySummary(fixedDateKey);
    expect(summaryAfterRefresh.totalSalesRecordedNgwee).toBe(11000);
    expect(summaryAfterRefresh.totalMoneyReceivedNgwee).toBe(4000);
  });

  it('supports repeated backup restorations back-and-forth and rejects tampered backup invariants', async () => {
    await updateShopName('Shop State One');
    const p1 = await createProduct({
      name: 'Cooking Salt 1kg',
      sellingPriceNgwee: 1200,
      costPriceNgwee: 850,
      initialStockQty: 10,
      now: fixedToday,
    });
    const c1 = await createCustomer({ name: 'Grace Zulu', now: fixedToday });
    await recordSale({
      operationId: createId('op'),
      paymentMethod: 'credit',
      customerId: c1.id,
      items: [{ productId: p1.id, quantity: 3 }], // K36.00
      now: fixedToday,
    });

    const backupStateOne = await createFullBackupJson(fixedToday);

    // Mutate shop into State Two
    await updateShopName('Shop State Two');
    await recordRepayment({
      operationId: createId('op'),
      customerId: c1.id,
      amountNgwee: 3600,
      paymentMethod: 'cash',
      now: fixedToday,
    });
    const backupStateTwo = await createFullBackupJson(fixedToday);

    // Restore State One -> State Two -> State One -> State One again (repeated restoration)
    await restoreBackupFromJson(backupStateOne);
    expect((await getShopSettings()).shopName).toBe('Shop State One');
    expect((await getCustomerStatement(c1.id)).summary.outstandingBalanceNgwee).toBe(3600);

    await restoreBackupFromJson(backupStateTwo);
    expect((await getShopSettings()).shopName).toBe('Shop State Two');
    expect((await getCustomerStatement(c1.id)).summary.outstandingBalanceNgwee).toBe(0);

    await restoreBackupFromJson(backupStateOne);
    await restoreBackupFromJson(backupStateOne);
    expect((await getShopSettings()).shopName).toBe('Shop State One');
    expect((await listProducts())[0].stockQty).toBe(7);

    // Confirm new operations still work cleanly after repeated restores
    await recordRepayment({
      operationId: createId('op'),
      customerId: c1.id,
      amountNgwee: 1000,
      paymentMethod: 'mobile_money',
      now: fixedToday,
    });
    expect((await getCustomerStatement(c1.id)).summary.outstandingBalanceNgwee).toBe(2600);

    // Reject backup where sale.totalNgwee does not match sum of saleItems
    const tampered = JSON.parse(backupStateOne);
    tampered.sales[0].totalNgwee = 99999;
    await expect(restoreBackupFromJson(JSON.stringify(tampered))).rejects.toThrow(
      ValidationError
    );
    // Existing balance of K26.00 remains untouched after failed restore
    expect((await getCustomerStatement(c1.id)).summary.outstandingBalanceNgwee).toBe(2600);
  });

  it('prevents receipt number collisions and negative balances if demo data is mixed and removed', async () => {
    await loadSampleDemoData(fixedToday);
    const realProduct = await createProduct({
      name: 'Real Candles Pack',
      sellingPriceNgwee: 2500,
      costPriceNgwee: 1900,
      initialStockQty: 10,
      now: fixedToday,
    });
    const realCustomer = await createCustomer({
      name: 'Real Neighbour',
      now: fixedToday,
    });

    // Record 1 real sale while demo data is present
    const firstRealSale = await recordSale({
      operationId: createId('op'),
      paymentMethod: 'cash',
      items: [{ productId: realProduct.id, quantity: 1 }],
      now: fixedToday,
    });

    // Also simulate user accidentally selling a [DEMO] product on credit to Real Neighbour + repaying it
    const demoItem = (await listProducts()).find((p) => p.isDemo)!;
    await recordSale({
      operationId: createId('op'),
      paymentMethod: 'credit',
      customerId: realCustomer.id,
      items: [{ productId: demoItem.id, quantity: 1 }],
      now: fixedToday,
    });
    await recordRepayment({
      operationId: createId('op'),
      customerId: realCustomer.id,
      amountNgwee: demoItem.sellingPriceNgwee,
      paymentMethod: 'cash',
      now: fixedToday,
    });

    // Remove demo data
    await removeDemoData();

    // Record 2 more real sales and verify zero duplicate receipt numbers
    const secondRealSale = await recordSale({
      operationId: createId('op'),
      paymentMethod: 'cash',
      items: [{ productId: realProduct.id, quantity: 1 }],
      now: fixedToday,
    });
    const thirdRealSale = await recordSale({
      operationId: createId('op'),
      paymentMethod: 'cash',
      items: [{ productId: realProduct.id, quantity: 1 }],
      now: fixedToday,
    });

    const receiptSet = new Set([
      firstRealSale.receiptNumber,
      secondRealSale.receiptNumber,
      thirdRealSale.receiptNumber,
    ]);
    expect(receiptSet.size).toBe(3);

    // Real Neighbour's balance is 0 (never negative) and backup round-trip succeeds
    const stmt = await getCustomerStatement(realCustomer.id);
    expect(stmt.summary.outstandingBalanceNgwee).toBe(0);
    const backup = await createFullBackupJson(fixedToday);
    await expect(restoreBackupFromJson(backup)).resolves.toBeDefined();
  });
});
