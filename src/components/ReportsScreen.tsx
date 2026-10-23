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
import { ChevronRightIcon } from './ui/icons';

interface ReportsScreenProps {
  refreshToken: number;
  onRestockProduct: (productId: string) => void;
  onOpenSettings: () => void;
}

const METHOD_LABEL = (sale: SaleWithItems): string => {
  if (sale.paymentMethod === 'cash') return 'Cash';
  if (sale.paymentMethod === 'mobile_money') {
    return sale.paymentReference
      ? `Mobile Money (${sale.paymentReference})`
      : 'Mobile Money';
  }
  return `Credit — ${sale.customerNameSnapshot ?? 'Customer'}`;
};

export const ReportsScreen: React.FC<ReportsScreenProps> = ({
  refreshToken,
  onRestockProduct,
  onOpenSettings,
}) => {
  const todayKey = toLocalDateKey();
  const [selectedDate, setSelectedDate] = useState<string>(todayKey);
  const [summary, setSummary] = useState<DaySummaryReport | null>(null);
  const [salesList, setSalesList] = useState<SaleWithItems[]>([]);
  const [showAllDatesSales, setShowAllDatesSales] = useState(false);
  const [dailyHistory, setDailyHistory] = useState<DailyTotalsRow[]>([]);
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null);
  const [showMoreReports, setShowMoreReports] = useState(false);
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
  const dayLabel = isViewingToday
    ? `Today — ${formatLocalDateLabel(selectedDate)}`
    : formatLocalDateLabel(selectedDate);

  return (
    <div>
      <header className="sb-page-head">
        <h1 className="sb-page-title">Reports</h1>
        <p className="sb-page-subtitle">Sales, money received and records</p>
      </header>

      <div className="sb-card sb-date-bar">
        <label className="sb-label" htmlFor="report-date">
          Day
        </label>
        <div className="sb-date-bar-controls">
          <input
            id="report-date"
            type="date"
            className="sb-input"
            value={selectedDate}
            max={todayKey}
            onChange={(event) => {
              if (event.target.value) setSelectedDate(event.target.value);
            }}
          />
          {!isViewingToday && (
            <button
              type="button"
              className="sb-btn sb-btn-sm"
              onClick={() => setSelectedDate(todayKey)}
            >
              Back to today
            </button>
          )}
        </div>
      </div>

      {isLoading || !summary ? (
        <div className="sb-card sb-loading-card" role="status" aria-live="polite">
          <span className="sb-spinner" aria-hidden="true" />
          Loading {dayLabel}…
        </div>
      ) : (
        <>
          <div className="sb-stat-grid">
            <div className="sb-stat-card">
              <div className="sb-stat-label">Money received</div>
              <div className="sb-stat-value is-money">
                {formatNgwee(summary.totalMoneyReceivedNgwee)}
              </div>
              <div className="sb-stat-caption">
                Cash and mobile money actually received
              </div>
            </div>

            <div className="sb-stat-card">
              <div className="sb-stat-label">Sales recorded</div>
              <div className="sb-stat-value">
                {formatNgwee(summary.totalSalesRecordedNgwee)}
              </div>
              <div className="sb-stat-caption">
                {summary.salesCount}{' '}
                {summary.salesCount === 1 ? 'sale recorded' : 'sales recorded'}
              </div>
            </div>

            <div className="sb-stat-card">
              <div className="sb-stat-label">Money owed by customers</div>
              <div className="sb-stat-value">
                {formatNgwee(summary.totalOutstandingCreditNgwee)}
              </div>
              <div className="sb-stat-caption">
                {summary.customersOwingCount === 1
                  ? '1 customer owes money'
                  : `${summary.customersOwingCount} customers owe money`}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="sb-disclosure"
            aria-expanded={showMoreReports}
            aria-controls="sb-more-reports"
            onClick={() => setShowMoreReports((value) => !value)}
          >
            <span>More reports</span>
            <ChevronRightIcon
              className={`sb-disclosure-chevron ${showMoreReports ? 'is-open' : ''}`}
            />
          </button>

          {showMoreReports && (
            <div id="sb-more-reports">
              <section className="sb-card">
                <h2 className="sb-card-title">How the money breaks down</h2>
                <p className="sb-card-subtitle">{dayLabel}</p>
                <dl className="sb-breakdown-list">
                  <div className="sb-breakdown-row">
                    <dt>Cash sales</dt>
                    <dd>{formatNgwee(summary.cashSalesNgwee)}</dd>
                  </div>
                  <div className="sb-breakdown-row">
                    <dt>Mobile Money sales (recorded by hand)</dt>
                    <dd>{formatNgwee(summary.mobileMoneySalesNgwee)}</dd>
                  </div>
                  <div className="sb-breakdown-row">
                    <dt>Credit sales — goods taken, not paid yet</dt>
                    <dd>{formatNgwee(summary.creditSalesNgwee)}</dd>
                  </div>
                  <div className="sb-breakdown-row">
                    <dt>Debt repaid in cash</dt>
                    <dd>{formatNgwee(summary.repaymentsCashNgwee)}</dd>
                  </div>
                  <div className="sb-breakdown-row">
                    <dt>Debt repaid by Mobile Money</dt>
                    <dd>{formatNgwee(summary.repaymentsMobileMoneyNgwee)}</dd>
                  </div>
                  <div className="sb-breakdown-row is-total">
                    <dt>Total cash + mobile money received</dt>
                    <dd>{formatNgwee(summary.totalMoneyReceivedNgwee)}</dd>
                  </div>
                </dl>
                <p className="sb-hint">
                  Debt repayments are never counted as new sales.
                </p>
              </section>

              <section className="sb-card">
                <h2 className="sb-card-title">Profit estimate</h2>
                <p className="sb-card-subtitle">
                  Selling price minus the cost price you recorded. This is not
                  net profit — rent, transport, power and wages are not
                  included.
                </p>
                <div className="sb-stat-value">
                  {summary.estimatedGrossProfitNgwee === null
                    ? 'Add cost prices to see this'
                    : formatNgwee(summary.estimatedGrossProfitNgwee)}
                </div>
                <dl className="sb-breakdown-list">
                  <div className="sb-breakdown-row">
                    <dt>Sales with a known cost price</dt>
                    <dd>{formatNgwee(summary.knownCostRevenueNgwee)}</dd>
                  </div>
                  <div className="sb-breakdown-row">
                    <dt>What those goods cost you</dt>
                    <dd>{formatNgwee(summary.knownCostTotalNgwee)}</dd>
                  </div>
                </dl>
                {summary.missingCostLineCount > 0 && (
                  <p className="sb-hint">
                    {summary.missingCostLineCount}{' '}
                    {summary.missingCostLineCount === 1 ? 'item has' : 'items have'}{' '}
                    no cost price recorded ({formatNgwee(summary.missingCostRevenueNgwee)}),
                    so they are left out of this estimate.
                  </p>
                )}
              </section>

              <section className="sb-card">
                <div className="sb-card-header">
                  <h2 className="sb-card-title">Running low</h2>
                  {summary.lowStockProducts.length > 0 && (
                    <span className="sb-badge sb-badge-low">
                      {summary.lowStockProducts.length}
                    </span>
                  )}
                </div>
                {summary.lowStockProducts.length === 0 ? (
                  <p className="sb-empty-text">
                    Everything has enough stock.
                  </p>
                ) : (
                  <ul className="sb-stock-warning-list">
                    {summary.lowStockProducts.map((product) => (
                      <li key={product.id} className="sb-stock-warning-row">
                        <div className="sb-stock-warning-text">
                          <span className="sb-stock-warning-name">
                            {product.name}
                          </span>
                          <span className="sb-stock-warning-qty">
                            {product.stockQty === 0
                              ? 'Out of stock'
                              : `${product.stockQty} left`}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="sb-btn sb-btn-sm"
                          onClick={() => onRestockProduct(product.id)}
                        >
                          Add stock
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="sb-card">
                <h2 className="sb-card-title">Best sellers</h2>
                <p className="sb-card-subtitle">On {dayLabel}</p>
                {summary.bestSellingProducts.length === 0 ? (
                  <p className="sb-empty-text">
                    No sales recorded on this day.
                  </p>
                ) : (
                  <ol className="sb-ranked-list">
                    {summary.bestSellingProducts.map((item) => (
                      <li key={item.productId} className="sb-ranked-row">
                        <span className="sb-ranked-name">{item.productName}</span>
                        <span className="sb-ranked-value">
                          {item.unitsSold} sold · {formatNgwee(item.revenueNgwee)}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="sb-card">
                <div className="sb-card-header">
                  <h2 className="sb-card-title">Sales history</h2>
                  <button
                    type="button"
                    className="sb-btn sb-btn-sm"
                    onClick={() => setShowAllDatesSales((value) => !value)}
                  >
                    {showAllDatesSales
                      ? `Only ${formatLocalDateLabel(selectedDate)}`
                      : 'Show all recent sales'}
                  </button>
                </div>
                {salesList.length === 0 ? (
                  <p className="sb-empty-text">No sales to show.</p>
                ) : (
                  <ul className="sb-list-divider sb-receipt-list">
                    {salesList.map((sale) => {
                      const isExpanded = expandedSaleId === sale.id;
                      return (
                        <li key={sale.id}>
                          <button
                            type="button"
                            className="sb-receipt-toggle"
                            aria-expanded={isExpanded}
                            onClick={() =>
                              setExpandedSaleId(isExpanded ? null : sale.id)
                            }
                          >
                            <span className="sb-receipt-main">
                              <span className="sb-receipt-title">
                                {sale.receiptNumber}
                                <span className="sb-receipt-time">
                                  {showAllDatesSales
                                    ? ` · ${formatLocalDateLabel(sale.localDate)}`
                                    : ''}{' '}
                                  · {formatTimeShort(sale.createdAt)}
                                </span>
                              </span>
                              <span className="sb-receipt-meta">
                                {METHOD_LABEL(sale)} · {sale.totalUnits}{' '}
                                {sale.totalUnits === 1 ? 'item' : 'items'}
                              </span>
                            </span>
                            <span className="sb-receipt-total">
                              {formatNgwee(sale.totalNgwee)}
                              <span className="sb-receipt-toggle-hint">
                                {isExpanded ? 'Hide items' : 'View items'}
                              </span>
                            </span>
                          </button>

                          {isExpanded && (
                            <div className="sb-receipt-items">
                              {sale.items.map((item) => (
                                <div key={item.id} className="sb-row-between">
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
                                <div className="sb-receipt-note">
                                  Note: {sale.note}
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="sb-card">
                <h2 className="sb-card-title">Day by day</h2>
                <p className="sb-card-subtitle">
                  Tap a day to see its summary above
                </p>
                {dailyHistory.length === 0 ? (
                  <p className="sb-empty-text">
                    Daily totals appear once sales or payments are recorded.
                  </p>
                ) : (
                  <div className="sb-table-wrap">
                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th scope="col">Day</th>
                          <th scope="col">Sales</th>
                          <th scope="col">Total sold</th>
                          <th scope="col">Credit sold</th>
                          <th scope="col">Debt repaid</th>
                          <th scope="col">Received</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dailyHistory.map((row) => (
                          <tr
                            key={row.localDate}
                            className={
                              row.localDate === selectedDate ? 'is-selected' : ''
                            }
                          >
                            <td>
                              <button
                                type="button"
                                className="sb-link-btn"
                                onClick={() => setSelectedDate(row.localDate)}
                              >
                                {formatLocalDateLabel(row.localDate)}
                              </button>
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
                            <td className="sb-table-total">
                              {formatNgwee(row.totalMoneyReceivedNgwee)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}

          <section className="sb-card">
            <div className="sb-row-between sb-card-header">
              <div>
                <h2 className="sb-card-title">Spreadsheets &amp; backup</h2>
                <p className="sb-card-subtitle">
                  Save a copy of your records so a lost phone does not mean lost
                  history
                </p>
              </div>
              <button
                type="button"
                className="sb-btn sb-btn-primary"
                onClick={onOpenSettings}
              >
                Open backup
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
