import { runTransaction, STORES } from '../db/indexedDb';
import { toLocalDateKey } from '../domain/ids';
import {
  BestSellingProductSummary,
  DailyTotalsRow,
  DaySummaryReport,
} from '../domain/types';

/**
 * Financial & Daily Summary Calculations.
 *
 * Accounting Rules Enforced Here:
 * 1. A credit sale IS a sale recorded today (`totalSalesRecordedNgwee` & `creditSalesNgwee`),
 *    but is NOT cash/money received today (`totalMoneyReceivedNgwee`).
 * 2. A customer debt repayment IS money received today (`totalRepaymentsReceivedNgwee` &
 *    `totalMoneyReceivedNgwee`), but is NOT a new sale (`totalSalesRecordedNgwee`).
 * 3. Neither credit sales nor repayments are ever double-counted.
 * 4. Estimated Gross Profit is calculated ONLY on sold items that had a cost price
 *    recorded at sale time; any items sold without cost prices are explicitly reported
 *    via `missingCostLineCount` and `missingCostRevenueNgwee`.
 */
export async function getDaySummary(
  localDate: string = toLocalDateKey()
): Promise<DaySummaryReport> {
  return runTransaction(
    [
      STORES.products,
      STORES.sales,
      STORES.saleItems,
      STORES.creditTransactions,
    ],
    'readonly',
    async (ctx) => {
      const [products, daySales, allSaleItems, allCreditTx] = await Promise.all([
        ctx.getAll(STORES.products),
        ctx.getAllByIndex(STORES.sales, 'by_localDate', localDate),
        ctx.getAll(STORES.saleItems),
        ctx.getAll(STORES.creditTransactions),
      ]);

      let cashSalesNgwee = 0;
      let mobileMoneySalesNgwee = 0;
      let creditSalesNgwee = 0;
      let knownCostRevenueNgwee = 0;
      let knownCostTotalNgwee = 0;
      let missingCostLineCount = 0;
      let missingCostRevenueNgwee = 0;

      const daySaleIds = new Set<string>();

      for (const sale of daySales) {
        daySaleIds.add(sale.id);
        if (sale.paymentMethod === 'cash') {
          cashSalesNgwee += sale.totalNgwee;
        } else if (sale.paymentMethod === 'mobile_money') {
          mobileMoneySalesNgwee += sale.totalNgwee;
        } else if (sale.paymentMethod === 'credit') {
          creditSalesNgwee += sale.totalNgwee;
        }
        knownCostRevenueNgwee += sale.knownCostRevenueNgwee;
        knownCostTotalNgwee += sale.knownCostTotalNgwee;
        missingCostLineCount += sale.missingCostLineCount;
        missingCostRevenueNgwee += sale.missingCostRevenueNgwee;
      }

      const totalSalesRecordedNgwee =
        cashSalesNgwee + mobileMoneySalesNgwee + creditSalesNgwee;

      // Repayments received on `localDate` AND total outstanding credit across ALL dates
      let repaymentsCashNgwee = 0;
      let repaymentsMobileMoneyNgwee = 0;
      const balanceByCustomer = new Map<string, number>();

      for (const tx of allCreditTx) {
        const prev = balanceByCustomer.get(tx.customerId) ?? 0;
        if (tx.type === 'credit_sale') {
          balanceByCustomer.set(tx.customerId, prev + tx.amountNgwee);
        } else if (tx.type === 'repayment') {
          balanceByCustomer.set(tx.customerId, prev - tx.amountNgwee);
          if (tx.localDate === localDate) {
            if (tx.paymentMethod === 'mobile_money') {
              repaymentsMobileMoneyNgwee += tx.amountNgwee;
            } else {
              repaymentsCashNgwee += tx.amountNgwee;
            }
          }
        }
      }

      let totalOutstandingCreditNgwee = 0;
      let customersOwingCount = 0;
      for (const bal of balanceByCustomer.values()) {
        if (bal > 0) {
          totalOutstandingCreditNgwee += bal;
          customersOwingCount += 1;
        }
      }

      const totalRepaymentsReceivedNgwee =
        repaymentsCashNgwee + repaymentsMobileMoneyNgwee;
      const totalCashReceivedNgwee = cashSalesNgwee + repaymentsCashNgwee;
      const totalMobileMoneyReceivedNgwee =
        mobileMoneySalesNgwee + repaymentsMobileMoneyNgwee;
      const totalMoneyReceivedNgwee =
        totalCashReceivedNgwee + totalMobileMoneyReceivedNgwee;

      // Estimated gross profit handling:
      // - If 0 sales on this day -> 0
      // - If sales occurred, and at least some revenue had known cost -> knownCostRevenue - knownCostTotal
      // - If sales occurred, and NO items had known cost -> null (signals "cost prices missing")
      let estimatedGrossProfitNgwee: number | null = 0;
      if (daySales.length > 0) {
        if (knownCostRevenueNgwee > 0 || missingCostLineCount === 0) {
          estimatedGrossProfitNgwee = knownCostRevenueNgwee - knownCostTotalNgwee;
        } else {
          estimatedGrossProfitNgwee = null;
        }
      }

      // Best-selling products for the selected date
      const productStats = new Map<string, BestSellingProductSummary>();
      for (const item of allSaleItems) {
        if (!daySaleIds.has(item.saleId)) continue;
        const existing = productStats.get(item.productId);
        if (existing) {
          existing.unitsSold += item.quantity;
          existing.revenueNgwee += item.lineTotalNgwee;
        } else {
          productStats.set(item.productId, {
            productId: item.productId,
            productName: item.productNameAtSale,
            unitsSold: item.quantity,
            revenueNgwee: item.lineTotalNgwee,
          });
        }
      }

      const bestSellingProducts = Array.from(productStats.values())
        .sort((a, b) =>
          b.unitsSold !== a.unitsSold
            ? b.unitsSold - a.unitsSold
            : b.revenueNgwee - a.revenueNgwee
        )
        .slice(0, 8);

      // Low-stock active products (lowest stockQty first)
      const lowStockProducts = products
        .filter((p) => !p.isArchived && p.stockQty <= p.lowStockThreshold)
        .sort((a, b) =>
          a.stockQty !== b.stockQty
            ? a.stockQty - b.stockQty
            : a.name.localeCompare(b.name)
        );

      return {
        localDate,
        salesCount: daySales.length,
        totalSalesRecordedNgwee,
        cashSalesNgwee,
        mobileMoneySalesNgwee,
        creditSalesNgwee,
        repaymentsCashNgwee,
        repaymentsMobileMoneyNgwee,
        totalRepaymentsReceivedNgwee,
        totalCashReceivedNgwee,
        totalMobileMoneyReceivedNgwee,
        totalMoneyReceivedNgwee,
        totalOutstandingCreditNgwee,
        customersOwingCount,
        estimatedGrossProfitNgwee,
        knownCostRevenueNgwee,
        knownCostTotalNgwee,
        missingCostLineCount,
        missingCostRevenueNgwee,
        bestSellingProducts,
        lowStockProducts,
      };
    }
  );
}

/**
 * Returns daily totals across all recorded business days (newest day first).
 */
export async function getDailyTotalsHistory(): Promise<DailyTotalsRow[]> {
  return runTransaction(
    [STORES.sales, STORES.creditTransactions],
    'readonly',
    async (ctx) => {
      const [sales, creditTxs] = await Promise.all([
        ctx.getAll(STORES.sales),
        ctx.getAll(STORES.creditTransactions),
      ]);

      const rowsByDate = new Map<string, DailyTotalsRow>();

      const getOrCreateRow = (localDate: string): DailyTotalsRow => {
        let row = rowsByDate.get(localDate);
        if (!row) {
          row = {
            localDate,
            salesCount: 0,
            totalSalesNgwee: 0,
            cashSalesNgwee: 0,
            mobileMoneySalesNgwee: 0,
            creditSalesNgwee: 0,
            repaymentsCashNgwee: 0,
            repaymentsMobileMoneyNgwee: 0,
            totalMoneyReceivedNgwee: 0,
          };
          rowsByDate.set(localDate, row);
        }
        return row;
      };

      for (const sale of sales) {
        const row = getOrCreateRow(sale.localDate);
        row.salesCount += 1;
        row.totalSalesNgwee += sale.totalNgwee;
        if (sale.paymentMethod === 'cash') {
          row.cashSalesNgwee += sale.totalNgwee;
        } else if (sale.paymentMethod === 'mobile_money') {
          row.mobileMoneySalesNgwee += sale.totalNgwee;
        } else if (sale.paymentMethod === 'credit') {
          row.creditSalesNgwee += sale.totalNgwee;
        }
      }

      for (const tx of creditTxs) {
        if (tx.type !== 'repayment') continue;
        const row = getOrCreateRow(tx.localDate);
        if (tx.paymentMethod === 'mobile_money') {
          row.repaymentsMobileMoneyNgwee += tx.amountNgwee;
        } else {
          row.repaymentsCashNgwee += tx.amountNgwee;
        }
      }

      for (const row of rowsByDate.values()) {
        row.totalMoneyReceivedNgwee =
          row.cashSalesNgwee +
          row.mobileMoneySalesNgwee +
          row.repaymentsCashNgwee +
          row.repaymentsMobileMoneyNgwee;
      }

      return Array.from(rowsByDate.values()).sort((a, b) =>
        b.localDate.localeCompare(a.localDate)
      );
    }
  );
}
