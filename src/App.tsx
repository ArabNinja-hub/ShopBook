import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccountSyncModal } from './components/AccountSyncModal';
import { CreditScreen } from './components/CreditScreen';
import { SellScreen } from './components/SellScreen';
import { ShopSettingsModal } from './components/ShopSettingsModal';
import { StockScreen } from './components/StockScreen';
import { TodayScreen } from './components/TodayScreen';
import {
  CustomerCreditSummary,
  Product,
  ShopSettings,
  StockMovement,
} from './domain/types';
import { fetchCurrentSession } from './services/authClientService';
import { listCustomersWithBalances } from './services/creditService';
import { listSalesWithItems } from './services/salesService';
import {
  getShopSettings,
  loadSampleDemoData,
  removeDemoData,
  updateShopName,
} from './services/shopService';
import { listProducts, listStockMovements } from './services/stockService';
import {
  acknowledgeStockConflictOnServer,
  getLocalSyncOverview,
  LocalSyncOverview,
  syncWithServer,
} from './services/syncClientService';
import { AuthSessionResponse } from './shared/syncTypes';

type NavTab = 'sell' | 'stock' | 'credit' | 'today';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavTab>('sell');
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<CustomerCreditSummary[]>([]);
  const [recentMovements, setRecentMovements] = useState<StockMovement[]>([]);
  const [totalSalesCount, setTotalSalesCount] = useState<number>(0);

  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [syncOverview, setSyncOverview] = useState<LocalSyncOverview | null>(
    null
  );
  const [isSyncing, setIsSyncing] = useState(false);

  const [cartUnitsCount, setCartUnitsCount] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isBackupModalOpen, setIsBackupModalOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);

  // Navigation intents for jumping straight into Stock actions
  const [openAddProductIntent, setOpenAddProductIntent] = useState(false);
  const [adjustProductIdIntent, setAdjustProductIdIntent] = useState<
    string | null
  >(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);

  const sessionRef = useRef<AuthSessionResponse | null>(null);
  sessionRef.current = session;

  const reloadLocalStores = useCallback(async () => {
    const [shopCfg, prods, custs, moves, recentSales, syncInfo] =
      await Promise.all([
        getShopSettings(),
        listProducts({ includeArchived: true }),
        listCustomersWithBalances(),
        listStockMovements({ limit: 30 }),
        listSalesWithItems({ limit: 1 }),
        getLocalSyncOverview(),
      ]);
    setSettings(shopCfg);
    setAllProducts(prods);
    setCustomers(custs);
    setRecentMovements(moves);
    setTotalSalesCount(recentSales.length);
    setSyncOverview(syncInfo);
    setRefreshToken((n) => n + 1);
    return syncInfo;
  }, []);

  const triggerBackgroundSync = useCallback(
    async (explicitSession?: AuthSessionResponse | null) => {
      const activeSess = explicitSession ?? sessionRef.current;
      if (!activeSess?.authenticated || !activeSess.shop || !activeSess.user) {
        return;
      }

      setIsSyncing(true);
      try {
        await syncWithServer({
          shop: activeSess.shop,
          userId: activeSess.user.id,
        });
        await reloadLocalStores();
      } catch {
        // Offline or awaiting explicit user shop-binding confirmation; local ledger stays intact
        const latestInfo = await getLocalSyncOverview().catch(() => null);
        if (latestInfo) {
          setSyncOverview(latestInfo);
        }
      } finally {
        setIsSyncing(false);
      }
    },
    [reloadLocalStores]
  );

  const reloadAllData = useCallback(async () => {
    try {
      setLoadError(null);
      const syncInfo = await reloadLocalStores();

      const activeSess = sessionRef.current;
      if (
        activeSess?.authenticated &&
        activeSess.shop &&
        syncInfo.boundShopId === activeSess.shop.id &&
        syncInfo.pendingOutboxCount > 0
      ) {
        void triggerBackgroundSync(activeSess);
      }
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : 'Failed to open local ShopBook database.'
      );
    } finally {
      setIsInitialLoading(false);
    }
  }, [reloadLocalStores, triggerBackgroundSync]);

  // Initial local load + non-blocking session check
  useEffect(() => {
    let cancelled = false;

    async function init() {
      await reloadAllData();
      try {
        const currentSess = await fetchCurrentSession();
        if (cancelled) return;
        setSession(currentSess);
        if (currentSess.authenticated && currentSess.shop) {
          await triggerBackgroundSync(currentSess);
        }
      } catch {
        // Offline or local-only environment: keep working seamlessly from IndexedDB
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [reloadAllData, triggerBackgroundSync]);

  // Automatically flush outbox when mobile data reconnects
  useEffect(() => {
    const handleOnline = () => {
      void triggerBackgroundSync();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [triggerBackgroundSync]);

  const activeProducts = useMemo(
    () => allProducts.filter((p) => !p.isArchived),
    [allProducts]
  );

  const lowStockCount = useMemo(
    () =>
      activeProducts.filter((p) => p.stockQty <= p.lowStockThreshold).length,
    [activeProducts]
  );

  const owingCustomersCount = useMemo(
    () => customers.filter((c) => c.outstandingBalanceNgwee > 0).length,
    [customers]
  );

  const handleSaveShopName = async (name: string) => {
    const updated = await updateShopName(name);
    setSettings(updated);
    const info = await getLocalSyncOverview();
    setSyncOverview(info);
    void triggerBackgroundSync();
  };

  const handleLoadDemo = async () => {
    await loadSampleDemoData();
    await reloadAllData();
  };

  const handleRemoveDemo = async () => {
    await removeDemoData();
    await reloadAllData();
  };

  const handleGoToAddProduct = () => {
    setOpenAddProductIntent(true);
    setActiveTab('stock');
  };

  const handleRestockProduct = (productId: string) => {
    setAdjustProductIdIntent(productId);
    setActiveTab('stock');
  };

  const handleExplicitSync = async () => {
    if (!session?.authenticated || !session.shop || !session.user) return;
    setIsSyncing(true);
    try {
      await syncWithServer({
        shop: session.shop,
        userId: session.user.id,
      });
      await reloadLocalStores();
    } finally {
      setIsSyncing(false);
    }
  };

  const showWelcomeSetup =
    !isInitialLoading &&
    allProducts.length === 0 &&
    totalSalesCount === 0 &&
    customers.length === 0;

  const isSignedIn = Boolean(session?.authenticated && session.shop);
  const pendingOutboxCount = syncOverview?.pendingOutboxCount ?? 0;
  const openConflicts = syncOverview?.openStockConflicts ?? [];

  const headerSubtitle = isSignedIn
    ? isSyncing
      ? 'ShopBook · Syncing...'
      : pendingOutboxCount > 0
        ? `ShopBook · ${pendingOutboxCount} Offline Pending`
        : 'ShopBook · Cloud Synced'
    : 'ShopBook · Local Ledger';

  const accountBtnLabel = isSignedIn
    ? isSyncing
      ? 'Syncing...'
      : pendingOutboxCount > 0
        ? `Sync (${pendingOutboxCount})`
        : 'Synced'
    : 'Account';

  return (
    <div className="sb-app">
      {/* Top Branded Header */}
      <header className="sb-header">
        <div className="sb-header-inner">
          <button
            type="button"
            className="sb-brand-btn"
            onClick={() => setIsBackupModalOpen(true)}
            title="Shop settings & backups"
          >
            <span className="sb-brand-icon-frame">
              <img
                src={`${import.meta.env.BASE_URL}brand/shopbook-icon.png`}
                alt="ShopBook icon"
              />
            </span>
            <span className="sb-brand-titles">
              <div className="sb-shop-name">
                {settings?.shopName ?? 'ShopBook'}
              </div>
              <div className="sb-brand-sub">{headerSubtitle}</div>
            </span>
          </button>

          {/* Desktop / Tablet Primary Tabs */}
          <nav className="sb-desktop-tabs" aria-label="Main sections">
            <button
              type="button"
              className={`sb-desktop-tab ${activeTab === 'sell' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('sell')}
            >
              Sell{cartUnitsCount > 0 ? ` (${cartUnitsCount})` : ''}
            </button>
            <button
              type="button"
              className={`sb-desktop-tab ${activeTab === 'stock' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('stock')}
            >
              Stock{lowStockCount > 0 ? ` (${lowStockCount} low)` : ''}
            </button>
            <button
              type="button"
              className={`sb-desktop-tab ${activeTab === 'credit' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('credit')}
            >
              Credit{owingCustomersCount > 0 ? ` (${owingCustomersCount})` : ''}
            </button>
            <button
              type="button"
              className={`sb-desktop-tab ${activeTab === 'today' ? 'is-active' : ''}`}
              onClick={() => setActiveTab('today')}
            >
              Today
            </button>
          </nav>

          <div className="sb-header-actions">
            <button
              type="button"
              className="sb-header-btn"
              onClick={() => {
                void reloadLocalStores();
                setIsAccountModalOpen(true);
              }}
              aria-label="Account and cloud sync"
            >
              {accountBtnLabel}
            </button>
            <button
              type="button"
              className="sb-header-btn"
              onClick={() => setIsBackupModalOpen(true)}
            >
              Backup &amp; Shop
            </button>
          </div>
        </div>
      </header>

      {/* Clear Demo Mode Notice if Sample Data is Active */}
      {settings?.hasDemoData && (
        <div className="sb-demo-banner">
          <div className="sb-demo-banner-inner">
            <span>
              Sample <strong>[DEMO]</strong> shop data is loaded for testing —
              do not mix with real shop records.
            </span>
            <button
              type="button"
              className="sb-btn sb-btn-sm"
              onClick={handleRemoveDemo}
            >
              Remove Demo Data
            </button>
          </div>
        </div>
      )}

      {/* Multi-Device Offline Stock Conflict Recount Notice */}
      {openConflicts.map((conflict) => (
        <div key={conflict.id} className="sb-demo-banner" role="alert">
          <div className="sb-demo-banner-inner">
            <span>
              <strong>Stock recount needed ({conflict.productName}):</strong>{' '}
              An offline sale of {conflict.requestedDeductionQty} completed
              while {conflict.serverQtyBefore} remained on server (sale kept,
              stock clamped to 0).
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="sb-btn sb-btn-sm"
                onClick={() => handleRestockProduct(conflict.productId)}
              >
                Recount Stock
              </button>
              {session?.shop && (
                <button
                  type="button"
                  className="sb-btn sb-btn-sm"
                  onClick={async () => {
                    await acknowledgeStockConflictOnServer(
                      session.shop!.id,
                      conflict.id
                    );
                    await reloadLocalStores();
                  }}
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        </div>
      ))}

      {/* Main Content */}
      <main className="sb-main">
        {loadError && (
          <div className="sb-alert sb-alert-error" role="alert">
            <span>{loadError}</span>
          </div>
        )}

        {isInitialLoading ? (
          <div className="sb-card" style={{ textAlign: 'center', padding: 28 }}>
            Opening local shop ledger...
          </div>
        ) : (
          <>
            {/* Keep SellScreen mounted so an in-progress cart is preserved if owner checks Stock or Credit */}
            <div style={{ display: activeTab === 'sell' ? 'block' : 'none' }}>
              <SellScreen
                products={activeProducts}
                customers={customers}
                showWelcomeSetup={showWelcomeSetup}
                shopName={settings?.shopName ?? 'My Shop'}
                onSaveShopName={handleSaveShopName}
                onGoToAddProduct={handleGoToAddProduct}
                onLoadDemoData={handleLoadDemo}
                onOpenBackupModal={() => setIsBackupModalOpen(true)}
                onDataChanged={reloadAllData}
                onCartCountChange={setCartUnitsCount}
              />
            </div>

            {activeTab === 'stock' && (
              <StockScreen
                allProducts={allProducts}
                recentMovements={recentMovements}
                initialAddModalOpen={openAddProductIntent}
                initialAdjustProductId={adjustProductIdIntent}
                onConsumedInitialIntent={() => {
                  setOpenAddProductIntent(false);
                  setAdjustProductIdIntent(null);
                }}
                onDataChanged={reloadAllData}
              />
            )}

            {activeTab === 'credit' && (
              <CreditScreen
                customers={customers}
                onDataChanged={reloadAllData}
              />
            )}

            {activeTab === 'today' && (
              <TodayScreen
                refreshToken={refreshToken}
                onRestockProduct={handleRestockProduct}
                onOpenBackupModal={() => setIsBackupModalOpen(true)}
              />
            )}
          </>
        )}
      </main>

      {/* Mobile Bottom Navigation */}
      <nav className="sb-bottom-nav" aria-label="Primary navigation">
        <div className="sb-bottom-nav-inner">
          <button
            type="button"
            className={`sb-nav-tab ${activeTab === 'sell' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('sell')}
          >
            {cartUnitsCount > 0 && (
              <span className="sb-nav-badge">{cartUnitsCount}</span>
            )}
            <svg
              className="sb-nav-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="9" cy="20" r="1.5" />
              <circle cx="17" cy="20" r="1.5" />
              <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.8a1 1 0 0 0 1-.8L21 7H6" />
            </svg>
            <span>Sell</span>
          </button>

          <button
            type="button"
            className={`sb-nav-tab ${activeTab === 'stock' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('stock')}
          >
            {lowStockCount > 0 && (
              <span className="sb-nav-badge is-warn">{lowStockCount}</span>
            )}
            <svg
              className="sb-nav-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
              <path d="M3.3 7.8L12 12.5l8.7-4.7M12 22v-9.5" />
            </svg>
            <span>Stock</span>
          </button>

          <button
            type="button"
            className={`sb-nav-tab ${activeTab === 'credit' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('credit')}
          >
            {owingCustomersCount > 0 && (
              <span className="sb-nav-badge is-warn">
                {owingCustomersCount}
              </span>
            )}
            <svg
              className="sb-nav-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              <path d="M9 7h6M9 11h6" />
            </svg>
            <span>Credit</span>
          </button>

          <button
            type="button"
            className={`sb-nav-tab ${activeTab === 'today' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('today')}
          >
            <svg
              className="sb-nav-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M3 3v18h18" />
              <path d="M7 14l4-4 3 3 5-6" />
            </svg>
            <span>Today</span>
          </button>
        </div>
      </nav>

      {/* Account, Pilot Registration & Multi-Device Sync Modal */}
      <AccountSyncModal
        isOpen={isAccountModalOpen}
        localShopName={settings?.shopName ?? 'My Shop'}
        session={session}
        syncOverview={syncOverview}
        isSyncing={isSyncing}
        onClose={() => setIsAccountModalOpen(false)}
        onSessionChanged={(nextSess) => setSession(nextSess)}
        onTriggerSync={handleExplicitSync}
        onDataChanged={reloadAllData}
      />

      {/* Shop Settings, CSV Exports & JSON Backup Modal */}
      {settings && (
        <ShopSettingsModal
          isOpen={isBackupModalOpen}
          settings={settings}
          onClose={() => setIsBackupModalOpen(false)}
          onSaveShopName={handleSaveShopName}
          onLoadDemoData={handleLoadDemo}
          onRemoveDemoData={handleRemoveDemo}
          onDataChanged={reloadAllData}
        />
      )}
    </div>
  );
};
