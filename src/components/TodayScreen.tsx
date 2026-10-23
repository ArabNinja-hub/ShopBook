import React, { useEffect, useState } from 'react';
import {
  formatLocalDateLabel,
  formatTimeShort,
  toLocalDateKey,
} from '../domain/ids';
import { formatNgwee } from '../domain/money';
import {
  DailyTotalsRow,
  DaySummaryReport,
  SaleWithItems,
} from '../domain/types';
import { listSalesWithItems } from '../services/salesService';
import {
  getDailyTotalsHistory,
  getDaySummary,
} from '../services/summaryService';

interface TodayScreenProps {
  refreshToken: number;
  onRestockProduct: (productId: string) => void;
  onOpenBackupModal: () => void;
}

export const TodayScreen: React.FC<TodayScreenProps> = ({
  refreshToken,
  onRestockProduct,
  onOpenBackupModal,
}) => {
  const todayKey = toLocalDateKey();
  const [selectedDate, setSelectedDate] = useState<string>(todayKey);
  const [summary, setSummary] = useState<DaySummaryReport | null>(null);
  const [salesList, setSalesList] = useState<SaleWithItems[]>([]);
  const [showAllDatesSales, setShowAllDatesSales] = useState(false);
  const [dailyHistory, setDailyHistory] = useState<DailyTotalsRow[]>([]);
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const [daySum, salesRows, historyRows] = await Promise.all([
          getDaySummary(selectedDate),
          listSalesWithItems(
            showAllDatesSales ? { limit: 100 } : { localDate: selectedDate }
          ),
          getDailyTotalsHistory(),
        ]);
        if (!cancelled) {
          setSummary(daySum);
          setSalesList(salesRows);
          setDailyHistory(historyRows);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedDate, showAllDatesSales, refreshToken]);

  const isViewingToday = selectedDate === todayKey;

  return (
    <div>
      {/* Date Selector Bar */}
      <div className="sb-card" style={{ padding: '10px 12px' }}>
        <div className="sb-row-between" style={{ flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: '1rem' }}>
              {isViewingToday
                ? `Today — ${formatLocalDateLabel(selectedDate)}`
                : `Summary for ${formatLocalDateLabel(selectedDate)}`}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--sb-text-muted)' }}>
              Select any date to inspect that day&apos;s sales and receipts
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="date"
              className="sb-input"
              style={{ width: 'auto', minHeight: 38, padding: '6px 10px', fontSize: '0.88rem' }}
              aria-label="Select business date"
              value={selectedDate}
              max={todayKey}
              onChange={(e) => {
                if (e.target.value) setSelectedDate(e.target.value);
              }}
            />
            {!isViewingToday && (
              <button
                type="button"
                className="sb-btn sb-btn-primary sb-btn-sm"
                onClick={() => setSelectedDate(todayKey)}
              >
                Today
              </button>
            )}
          </div>
        </div>
      </div>

      {isLoading || !summary ? (
        <div className="sb-card">Loading summary...</div>
      ) : (
        <>
          {/* Core Financial Metrics Grid */}
          <div className="sb-metrics-grid">
            {/* 1. Sales Recorded */}
            <div className="sb-metric-card">
              <div className="sb-metric-label">
                Sales Recorded ({isViewingToday ? 'Today' : formatLocalDateLabel(selectedDate)})
              </div>
              <div className="sb-metric-value">
                {formatNgwee(summary.totalSalesRecordedNgwee)}
              </div>
              <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                {summary.salesCount} {summary.salesCount === 1 ? 'sale' : 'sales'} recorded
              </div>
              <div className="sb-metric-breakdown">
                <div className="sb-row-between">
                  <span>Cash sales:</span>
                  <strong>{formatNgwee(summary.cashSalesNgwee)}</strong>
                </div>
                <div className="sb-row-between">
                  <span>Mobile Money sales (manual):</span>
                  <strong>{formatNgwee(summary.mobileMoneySalesNgwee)}</strong>
                </div>
                <div className="sb-row-between">
                  <span>Credit sales (not cash yet):</span>
                  <strong>{formatNgwee(summary.creditSalesNgwee)}</strong>
                </div>
                <span style={{ fontSize: '0.76rem', color: 'var(--sb-text-soft)', marginTop: 2 }}>
                  Debt repayments are never counted as new sales.
                </span>
              </div>
            </div>

            {/* 2. Cash & Mobile Money Receipts */}
            <div className="sb-metric-card">
              <div className="sb-metric-label">
                Cash &amp; Mobile Money Received
              </div>
              <div
                className="sb-metric-value"
                style={{ color: 'var(--sb-green-700)' }}
              >
                {formatNgwee(summary.totalMoneyReceivedNgwee)}
              </div>
              <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                Actual payments recorded on this day
              </div>
              <div className="sb-metric-breakdown">
                <div className="sb-row-between">
                  <span>Cash received (sales + repayments):</span>
                  <strong>{formatNgwee(summary.totalCashReceivedNgwee)}</strong>
                </div>
                <div className="sb-row-between">
                  <span>Mobile Money recorded:</span>
                  <strong>
                    {formatNgwee(summary.totalMobileMoneyReceivedNgwee)}
                  </strong>
                </div>
                <div className="sb-row-between">
                  <span>Of which debt repayments collected:</span>
                  <strong>
                    {formatNgwee(summary.totalRepaymentsReceivedNgwee)}
                  </strong>
                </div>
                <span style={{ fontSize: '0.76rem', color: 'var(--sb-text-soft)', marginTop: 2 }}>
                  Credit sales are excluded until the customer repays.
                </span>
              </div>
            </div>

            {/* 3. Credit Sales & Total Outstanding Debt */}
            <div className="sb-metric-card">
              <div className="sb-metric-label">
                Credit Sales &amp; Outstanding Debt
              </div>
              <div
                className="sb-metric-value"
                style={{
                  color:
                    summary.totalOutstandingCreditNgwee > 0
                      ? 'var(--sb-amber-text)'
                      : 'var(--sb-pine-900)',
                }}
              >
                {formatNgwee(summary.totalOutstandingCreditNgwee)}
              </div>
              <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>
                Total currently owed across{' '}
                {summary.customersOwingCount}{' '}
                {summary.customersOwingCount === 1 ? 'customer' : 'customers'}
              </div>
              <div className="sb-metric-breakdown">
                <div className="sb-row-between">
                  <span>New credit given on this date:</span>
                  <strong>{formatNgwee(summary.creditSalesNgwee)}</strong>
                </div>
                <div className="sb-row-between">
                  <span>Repayments collected on this date:</span>
                  <strong>
                    {formatNgwee(summary.totalRepaymentsReceivedNgwee)}
                  </strong>
                </div>
              </div>
            </div>

            {/* 4. Estimated Gross Profit */}
            <div className="sb-metric-card">
              <div className="sb-metric-label">
                Estimated Gross Profit (Before Expenses)
              </div>
              <div
                className="sb-metric-value"
                style={{
                  color:
                    summary.estimatedGrossProfitNgwee !== null &&
                    summary.estimatedGrossProfitNgwee < 0
                      ? 'var(--sb-red-text)'
                      : undefined,
                }}
              >
                {summary.estimatedGrossProfitNgwee === null
                  ? 'Cost prices needed'
                  : formatNgwee(summary.estimatedGrossProfitNgwee)}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--sb-text-muted)' }}>
                Selling price minus item cost price — <strong>not net profit</strong>{' '}
                (excludes rent, transport, power, or wages).
              </div>
              <div className="sb-metric-breakdown">
                <div className="sb-row-between">
                  <span>Sales with known cost:</span>
                  <strong>{formatNgwee(summary.knownCostRevenueNgwee)}</strong>
                </div>
                <div className="sb-row-between">
                  <span>Recorded item cost:</span>
                  <strong>{formatNgwee(summary.knownCostTotalNgwee)}</strong>
                </div>
                {summary.missingCostLineCount > 0 && (
                  <div
                    className="sb-alert sb-alert-warn"
                    style={{ margin: '6px 0 0', padding: '7px 9px', fontSize: '0.78rem' }}
                  >
                    <span>
                      <strong>Incomplete cost data:</strong>{' '}
                      {summary.missingCostLineCount} sold item{' '}
                      {summary.missingCostLineCount === 1 ? 'line' : 'lines'} (
                      {formatNgwee(summary.missingCostRevenueNgwee)}) had no
                      cost price recorded and are excluded from this estimate.
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Low-Stock Warnings */}
          {summary.lowStockProducts.length > 0 && (
            <div className="sb-card">
              <div className="sb-card-header">
                <div>
                  <h2 className="sb-card-title">
                    Low-Stock Warnings ({summary.lowStockProducts.length})
                  </h2>
                  <p className="sb-card-subtitle">
                    Active items at or below their warning threshold
                  </p>
                </div>
              </div>

              <div className="sb-list-divider">
                {summary.lowStockProducts.map((product) => (
                  <div key={product.id} className="sb-row-between">
                    <div>
                      <div style={{ fontWeight: 700 }}>{product.name}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--sb-text-muted)' }}>
                        {product.stockQty === 0 ? (
                          <span className="sb-badge sb-badge-out">
                            Out of stock (0 left)
                          </span>
                        ) : (
                          <span className="sb-badge sb-badge-low">
                            Only {product.stockQty} left (alert ≤{' '}
                            {product.lowStockThreshold})
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="sb-btn sb-btn-primary sb-btn-sm"
                      onClick={() => onRestockProduct(product.id)}
                    >
                      Restock
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Best-Selling Products */}
          <div className="sb-card">
            <div className="sb-card-header">
              <div>
                <h2 className="sb-card-title">Best-Selling Products</h2>
                <p className="sb-card-subtitle">
                  Top items sold on {formatLocalDateLabel(selectedDate)}
                </p>
              </div>
            </div>

            {summary.bestSellingProducts.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--sb-text-muted)' }}>
                No sales recorded on {formatLocalDateLabel(selectedDate)}.
              </p>
            ) : (
              <div className="sb-list-divider">
                {summary.bestSellingProducts.map((item, idx) => (
                  <div key={item.productId} className="sb-row-between">
                    <div>
                      <span style={{ fontWeight: 700 }}>
                        {idx + 1}. {item.productName}
                      </span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <strong>{item.unitsSold} sold</strong> ·{' '}
                      <span style={{ color: 'var(--sb-text-muted)' }}>
                        {formatNgwee(item.revenueNgwee)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sales History (Receipts) */}
          <div className="sb-card">
            <div className="sb-card-header">
              <div>
                <h2 className="sb-card-title">Sales Receipts History</h2>
                <p className="sb-card-subtitle">
                  Tap any receipt to inspect item prices preserved at sale time
                </p>
              </div>
              <button
                type="button"
                className="sb-btn sb-btn-sm"
                onClick={() => setShowAllDatesSales((v) => !v)}
              >
                {showAllDatesSales
                  ? `Filter to ${formatLocalDateLabel(selectedDate)}`
                  : 'Show All Recent Sales'}
              </button>
            </div>

            {salesList.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--sb-text-muted)' }}>
                No sales receipts to display.
              </p>
            ) : (
              <div className="sb-list-divider">
                {salesList.map((sale) => {
                  const isExpanded = expandedSaleId === sale.id;
                  const methodBadge =
                    sale.paymentMethod === 'cash'
                      ? 'Cash'
                      : sale.paymentMethod === 'mobile_money'
                        ? `Mobile Money${sale.paymentReference ? ` (${sale.paymentReference})` : ''}`
                        : `Credit — ${sale.customerNameSnapshot ?? 'Customer'}`;

                  return (
                    <div key={sale.id}>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedSaleId(isExpanded ? null : sale.id)
                        }
                        style={{
                          width: '100%',
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          textAlign: 'left',
                        }}
                      >
                        <div className="sb-row-between">
                          <div>
                            <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>
                              {sale.receiptNumber}{' '}
                              <span
                                style={{
                                  fontWeight: 500,
                                  color: 'var(--sb-text-muted)',
                                  fontSize: '0.8rem',
                                }}
                              >
                                ·{' '}
                                {showAllDatesSales
                                  ? `${formatLocalDateLabel(sale.localDate)} `
                                  : ''}
                                {formatTimeShort(sale.createdAt)}
                              </span>
                            </div>
                            <div
                              style={{
                                fontSize: '0.8rem',
                                color: 'var(--sb-text-muted)',
                              }}
                            >
                              {methodBadge} · {sale.totalUnits}{' '}
                              {sale.totalUnits === 1 ? 'unit' : 'units'}
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontWeight: 800 }}>
                              {formatNgwee(sale.totalNgwee)}
                            </div>
                            <div
                              style={{
                                fontSize: '0.75rem',
                                color: 'var(--sb-green-700)',
                              }}
                            >
                              {isExpanded ? 'Hide items ▲' : 'View items ▼'}
                            </div>
                          </div>
                        </div>
                      </button>

                      {isExpanded && (
                        <div
                          style={{
                            marginTop: 8,
                            padding: 10,
                            borderRadius: 'var(--sb-radius-sm)',
                            backgroundColor: 'var(--sb-surface-subtle)',
                            border: '1px solid var(--sb-border)',
                            fontSize: '0.84rem',
                          }}
                        >
                          {sale.items.map((item) => (
                            <div
                              key={item.id}
                              className="sb-row-between"
                              style={{ padding: '3px 0' }}
                            >
                              <span>
                                {item.quantity} × {item.productNameAtSale} @{' '}
                                {formatNgwee(item.sellingPriceAtSaleNgwee)}
                                {item.costPriceAtSaleNgwee !== null
                                  ? ` (cost ${formatNgwee(item.costPriceAtSaleNgwee)})`
                                  : ' (cost not set)'}
                              </span>
                              <strong>{formatNgwee(item.lineTotalNgwee)}</strong>
                            </div>
                          ))}
                          {sale.note && (
                            <div
                              style={{
                                marginTop: 6,
                                color: 'var(--sb-text-muted)',
                              }}
                            >
                              Note: {sale.note}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Daily Totals History Table */}
          <div className="sb-card">
            <div className="sb-card-header">
              <div>
                <h2 className="sb-card-title">Daily Totals History</h2>
                <p className="sb-card-subtitle">
                  Tap any date row to view its full summary above
                </p>
              </div>
            </div>

            {dailyHistory.length === 0 ? (
              <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--sb-text-muted)' }}>
                Daily totals will appear here once sales or repayments are recorded.
              </p>
            ) : (
              <div className="sb-table-wrap">
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Sales</th>
                      <th>Total Sold</th>
                      <th>Credit Sold</th>
                      <th>Debt Repaid</th>
                      <th>Money Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyHistory.map((row) => (
                      <tr
                        key={row.localDate}
                        onClick={() => setSelectedDate(row.localDate)}
                        style={{
                          cursor: 'pointer',
                          backgroundColor:
                            row.localDate === selectedDate
                              ? 'var(--sb-green-100)'
                              : undefined,
                        }}
                      >
                        <td style={{ fontWeight: 700 }}>
                          {formatLocalDateLabel(row.localDate)}
                        </td>
                        <td>{row.salesCount}</td>
                        <td>{formatNgwee(row.totalSalesNgwee)}</td>
                        <td>{formatNgwee(row.creditSalesNgwee)}</td>
                        <td>
                          {formatNgwee(
                            row.repaymentsCashNgwee +
                              row.repaymentsMobileMoneyNgwee
                          )}
                        </td>
                        <td style={{ fontWeight: 700, color: 'var(--sb-green-700)' }}>
                          {formatNgwee(row.totalMoneyReceivedNgwee)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Quick Link to CSV Exports & Full Backup */}
          <div className="sb-card">
            <div className="sb-row-between" style={{ flexWrap: 'wrap' }}>
              <div>
                <h2 className="sb-card-title">
                  Export Spreadsheets &amp; Backup Shop Records
                </h2>
                <p className="sb-card-subtitle">
                  Download CSV files for Excel/Sheets or save a complete JSON
                  backup to protect against phone loss
                </p>
              </div>
              <button
                type="button"
                className="sb-btn sb-btn-primary"
                onClick={onOpenBackupModal}
              >
                Open Exports &amp; Backup
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
