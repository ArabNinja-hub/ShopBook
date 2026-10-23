import React, { useEffect, useMemo, useState } from 'react';
import { formatLocalDateLabel, toLocalDateKey } from '../domain/ids';
import { formatNgwee } from '../domain/money';
import { CustomerCreditSummary, Product } from '../domain/types';
import { getDaySummary } from '../services/summaryService';
import { Banner } from './ui/Banner';
import {
  ChevronRightIcon,
  CreditIcon,
  SellIcon,
  StockIcon,
} from './ui/icons';

interface HomeScreenProps {
  shopName: string;
  products: Product[];
  customers: CustomerCreditSummary[];
  showWelcomeSetup: boolean;
  refreshToken: number;
  isSignedIn: boolean;
  pendingOutboxCount: number;
  isSyncing: boolean;
  apiReachable: boolean | null;
  onSaveShopName: (name: string) => Promise<void>;
  onRecordSale: () => void;
  onAddProduct: () => void;
  onViewCredit: () => void;
  onRestockProduct: (productId: string) => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
  onOpenSampleData: () => void;
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  shopName,
  products,
  customers,
  showWelcomeSetup,
  refreshToken,
  isSignedIn,
  pendingOutboxCount,
  isSyncing,
  apiReachable,
  onSaveShopName,
  onRecordSale,
  onAddProduct,
  onViewCredit,
  onRestockProduct,
  onOpenSettings,
  onOpenAccount,
  onOpenSampleData,
}) => {
  const [todaySalesNgwee, setTodaySalesNgwee] = useState<number | null>(null);
  const [todaySalesCount, setTodaySalesCount] = useState<number | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const [welcomeNameInput, setWelcomeNameInput] = useState(shopName);
  const [isSavingWelcomeName, setIsSavingWelcomeName] = useState(false);
  const [welcomeError, setWelcomeError] = useState<string | null>(null);

  useEffect(() => {
    setWelcomeNameInput(shopName);
  }, [shopName]);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);

    getDaySummary(toLocalDateKey())
      .then((summary) => {
        if (cancelled) return;
        setTodaySalesNgwee(summary.totalSalesRecordedNgwee);
        setTodaySalesCount(summary.salesCount);
      })
      .catch(() => {
        if (cancelled) return;
        setTodaySalesNgwee(null);
        setTodaySalesCount(null);
        setLoadFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const moneyOwed = useMemo(() => {
    let total = 0;
    let count = 0;
    for (const customer of customers) {
      if (customer.outstandingBalanceNgwee > 0) {
        total += customer.outstandingBalanceNgwee;
        count += 1;
      }
    }
    return { total, count };
  }, [customers]);

  const runningLow = useMemo(
    () =>
      products
        .filter((product) => product.stockQty <= product.lowStockThreshold)
        .slice(0, 5),
    [products]
  );

  const isDataLoading = todaySalesNgwee === null && !loadFailed;

  const storageSummary = isSignedIn
    ? isSyncing
      ? 'Syncing with your ShopBook account…'
      : pendingOutboxCount > 0
        ? `${pendingOutboxCount} ${pendingOutboxCount === 1 ? 'record is' : 'records are'} still saved on this phone and waiting to sync.`
        : 'Your records are synced with your ShopBook account.'
    : 'Your records are saved on this phone only. Nothing is sent to a server, so download a backup regularly.';

  const handleSaveWelcomeName = async (event: React.FormEvent) => {
    event.preventDefault();
    setWelcomeError(null);
    setIsSavingWelcomeName(true);
    try {
      await onSaveShopName(welcomeNameInput);
    } catch (err) {
      setWelcomeError(
        err instanceof Error ? err.message : 'Could not save shop name.'
      );
    } finally {
      setIsSavingWelcomeName(false);
    }
  };

  return (
    <div className="sb-home">
      {showWelcomeSetup && (
        <section className="sb-welcome-card" aria-labelledby="sb-welcome-title">
          <img
            src={`${import.meta.env.BASE_URL}brand/shopbook-logo.png`}
            alt="ShopBook — Smarter Sales. Better Business."
            className="sb-logo-full"
          />
          <h1 className="sb-welcome-title" id="sb-welcome-title">
            Welcome to ShopBook
          </h1>
          <p className="sb-welcome-copy">
            Record sales, keep stock and track customer credit in Zambian
            Kwacha — stored on your own phone, even when mobile data is off.
          </p>

          {welcomeError && (
            <Banner tone="error" onDismiss={() => setWelcomeError(null)}>
              {welcomeError}
            </Banner>
          )}

          <form className="sb-welcome-form" onSubmit={handleSaveWelcomeName}>
            <label className="sb-label" htmlFor="welcome-shop-name">
              Shop name
            </label>
            <div className="sb-welcome-form-row">
              <input
                id="welcome-shop-name"
                type="text"
                className="sb-input"
                placeholder="e.g. Chanda General"
                value={welcomeNameInput}
                onChange={(event) => setWelcomeNameInput(event.target.value)}
              />
              <button
                type="submit"
                className="sb-btn"
                disabled={isSavingWelcomeName}
              >
                {isSavingWelcomeName ? 'Saving…' : 'Save Name'}
              </button>
            </div>
          </form>

          <button
            type="button"
            className="sb-btn sb-btn-primary sb-btn-block sb-btn-lg"
            onClick={onAddProduct}
          >
            Add your first product
          </button>

          <p className="sb-welcome-hint">
            Want to look around first?{' '}
            <button
              type="button"
              className="sb-link-btn"
              onClick={onOpenSampleData}
            >
              See a sample shop
            </button>{' '}
            or{' '}
            <button
              type="button"
              className="sb-link-btn"
              onClick={onOpenSettings}
            >
              restore a backup
            </button>
            .
          </p>
        </section>
      )}

      <header className="sb-page-head">
        <h1 className="sb-page-title">Home</h1>
        <p className="sb-page-subtitle">{formatLocalDateLabel(toLocalDateKey())}</p>
      </header>

      <div className="sb-stat-grid">
        <div className="sb-stat-card">
          <span className="sb-stat-label">Sales today</span>
          <span
            className="sb-stat-value"
            aria-busy={isDataLoading ? 'true' : undefined}
          >
            {isDataLoading ? '—' : formatNgwee(todaySalesNgwee ?? 0)}
          </span>
          <span className="sb-stat-caption">
            {loadFailed
              ? 'Could not read sales on this device'
              : todaySalesCount === null
                ? 'Loading…'
                : `${todaySalesCount} ${todaySalesCount === 1 ? 'sale' : 'sales'} recorded`}
          </span>
        </div>

        <button
          type="button"
          className="sb-stat-card is-action"
          onClick={onViewCredit}
        >
          <span className="sb-stat-label">Money owed</span>
          <span className="sb-stat-value">{formatNgwee(moneyOwed.total)}</span>
          <span className="sb-stat-caption">
            {moneyOwed.count === 0
              ? 'Nobody owes you money'
              : moneyOwed.count === 1
                ? '1 customer owes you'
                : `${moneyOwed.count} customers owe you`}
          </span>
        </button>
      </div>

      <section className="sb-actions" aria-labelledby="sb-quick-actions-title">
        <h2 className="sb-section-title" id="sb-quick-actions-title">
          What do you want to do?
        </h2>

        <button
          type="button"
          className="sb-action-row sb-action-row-primary"
          onClick={onRecordSale}
        >
          <span className="sb-action-icon">
            <SellIcon />
          </span>
          <span className="sb-action-text">
            <span className="sb-action-title">Record a sale</span>
            <span className="sb-action-subtitle">
              Add items and take cash, mobile money or credit
            </span>
          </span>
          <ChevronRightIcon className="sb-action-chevron" />
        </button>

        <button type="button" className="sb-action-row" onClick={onAddProduct}>
          <span className="sb-action-icon">
            <StockIcon />
          </span>
          <span className="sb-action-text">
            <span className="sb-action-title">Add a product</span>
            <span className="sb-action-subtitle">
              Set a selling price and how many you have
            </span>
          </span>
          <ChevronRightIcon className="sb-action-chevron" />
        </button>

        <button type="button" className="sb-action-row" onClick={onViewCredit}>
          <span className="sb-action-icon">
            <CreditIcon />
          </span>
          <span className="sb-action-text">
            <span className="sb-action-title">View credit</span>
            <span className="sb-action-subtitle">
              See who owes you money and record payments
            </span>
          </span>
          <ChevronRightIcon className="sb-action-chevron" />
        </button>
      </section>

      <section className="sb-card" aria-labelledby="sb-running-low-title">
        <div className="sb-card-header">
          <h2 className="sb-card-title" id="sb-running-low-title">
            Running low
          </h2>
          {runningLow.length > 0 && (
            <span className="sb-badge sb-badge-low">
              {runningLow.length} {runningLow.length === 1 ? 'item' : 'items'}
            </span>
          )}
        </div>

        {products.length === 0 ? (
          <p className="sb-empty-text">
            No products yet. Add a product to start selling.
          </p>
        ) : runningLow.length === 0 ? (
          <p className="sb-empty-text">
            Everything has enough stock. Nothing to restock right now.
          </p>
        ) : (
          <ul className="sb-stock-warning-list">
            {runningLow.map((product) => (
              <li key={product.id} className="sb-stock-warning-row">
                <div className="sb-stock-warning-text">
                  <span className="sb-stock-warning-name">{product.name}</span>
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

      <section className="sb-card sb-storage-card" aria-labelledby="sb-storage-title">
        <h2 className="sb-card-title" id="sb-storage-title">
          Where your records are kept
        </h2>
        <p className="sb-storage-text">{storageSummary}</p>
        {apiReachable === false && !isSignedIn && (
          <p className="sb-storage-note">
            Cloud sync is unavailable right now because the ShopBook server
            cannot be reached. Selling, stock and credit still work offline.
          </p>
        )}
        <div className="sb-storage-actions">
          <button type="button" className="sb-btn sb-btn-sm" onClick={onOpenSettings}>
            Back up records
          </button>
          <button type="button" className="sb-btn sb-btn-sm" onClick={onOpenAccount}>
            {isSignedIn ? 'Account & sync' : 'Turn on cloud sync'}
          </button>
        </div>
      </section>

      <p className="sb-home-footer">
        Tip: record every sale, even the small ones — the totals only help if
        they are complete.
      </p>
    </div>
  );
};
