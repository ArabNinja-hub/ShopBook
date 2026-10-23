import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccountSyncModal } from './components/AccountSyncModal';
import { CreditScreen } from './components/CreditScreen';
import { HomeScreen } from './components/HomeScreen';
import { ReportsScreen } from './components/ReportsScreen';
import { SampleDataModal } from './components/SampleDataModal';
import { SellScreen } from './components/SellScreen';
import { ShopSettingsModal } from './components/ShopSettingsModal';
import { StockScreen } from './components/StockScreen';
import {
  CreditIcon,
  HomeIcon,
  ReportsIcon,
  SellIcon,
  SettingsIcon,
  StockIcon,
  UserIcon,
} from './components/ui/icons';
import {
  CustomerCreditSummary,
  Product,
  ShopSettings,
  StockMovement,
} from './domain/types';
import { ApiClientError } from './services/apiClient';
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

type NavTab = 'home' | 'sell' | 'stock' | 'credit' | 'reports';

interface NavItem {
  id: NavTab;
  label: string;
  icon: React.FC<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: HomeIcon },
  { id: 'sell', label: 'Sell', icon: SellIcon },
  { id: 'stock', label: 'Stock', icon: StockIcon },
  { id: 'credit', label: 'Credit', icon: CreditIcon },
  { id: 'reports', label: 'Reports', icon: ReportsIcon },
];

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavTab>('home');
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<CustomerCreditSummary[]>([]);
  const [recentMovements, setRecentMovements] = useState<StockMovement[]>([]);
  const [totalSalesCount, setTotalSalesCount] = useState<number>(0);

  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const [syncOverview, setSyncOverview] = useState<LocalSyncOverview | null>(
    null
  );
  const [isSyncing, setIsSyncing] = useState(false);

  const [cartUnitsCount, setCartUnitsCount] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [isSampleDataOpen, setIsSampleDataOpen] = useState(false);

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
          : 'Failed to open the records saved on this phone.'
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
        setApiReachable(true);
        setSession(currentSess);
        if (currentSess.authenticated && currentSess.shop) {
          await triggerBackgroundSync(currentSess);
        }
      } catch (err) {
        if (cancelled) return;
        // 404 / 0 means there is no ShopBook API on this host (e.g. a static-only
        // deployment). Anything else means the API exists but the request failed.
        const status = err instanceof ApiClientError ? err.statusCode : 0;
        setApiReachable(!(status === 404 || status === 0));
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

  const hasAnyRecords =
    allProducts.length > 0 || totalSalesCount > 0 || customers.length > 0;

  const realProductCount = allProducts.filter((p) => !p.isDemo).length;
  const realRecordsExist =
    realProductCount > 0 ||
    customers.some((c) => !c.customer.isDemo) ||
    totalSalesCount > 0;

  const showWelcomeSetup = !isInitialLoading && !hasAnyRecords;

  const isSignedIn = Boolean(session?.authenticated && session.shop);
  const pendingOutboxCount = syncOverview?.pendingOutboxCount ?? 0;
  const openConflicts = syncOverview?.openStockConflicts ?? [];

  const statusText = isSyncing
    ? 'Syncing…'
    : isSignedIn
      ? pendingOutboxCount > 0
        ? `${pendingOutboxCount} waiting to sync`
        : 'Synced with cloud'
      : 'Saved on this phone';

  const statusTone = isSyncing
    ? 'is-busy'
    : isSignedIn && pendingOutboxCount === 0
      ? 'is-synced'
      : 'is-local';

  const navBadge = (tab: NavTab): { count: number; tone: 'info' | 'warn' } | null => {
    if (tab === 'sell' && cartUnitsCount > 0) {
      return { count: cartUnitsCount, tone: 'info' };
    }
    if (tab === 'stock' && lowStockCount > 0) {
      return { count: lowStockCount, tone: 'warn' };
    }
    if (tab === 'credit' && owingCustomersCount > 0) {
      return { count: owingCustomersCount, tone: 'warn' };
    }
    return null;
  };

  const desktopTabLabel = (tab: NavTab): string => {
    if (tab === 'sell' && cartUnitsCount > 0) return `Sell (${cartUnitsCount})`;
    if (tab === 'stock' && lowStockCount > 0) return `Stock (${lowStockCount} low)`;
    if (tab === 'credit' && owingCustomersCount > 0) {
      return `Credit (${owingCustomersCount})`;
    }
    return NAV_ITEMS.find((item) => item.id === tab)?.label ?? tab;
  };

  return (
    <div className="sb-app">
      <a className="sb-skip-link" href="#sb-main-content">
        Skip to main content
      </a>

      <header className="sb-header">
        <div className="sb-header-inner">
          <div className="sb-brand">
            <span className="sb-brand-icon-frame">
              <img
                src={`${import.meta.env.BASE_URL}brand/shopbook-icon.png`}
                alt="ShopBook icon"
              />
            </span>
            <span className="sb-brand-titles">
              <span className="sb-shop-name">
                {settings?.shopName ?? 'ShopBook'}
              </span>
              <span className={`sb-status ${statusTone}`}>{statusText}</span>
            </span>
          </div>

          <nav className="sb-desktop-tabs" aria-label="Main sections">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`sb-desktop-tab ${activeTab === item.id ? 'is-active' : ''}`}
                aria-current={activeTab === item.id ? 'page' : undefined}
                onClick={() => setActiveTab(item.id)}
              >
                {desktopTabLabel(item.id)}
              </button>
            ))}
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
              <UserIcon className="sb-header-btn-icon" />
              <span className="sb-header-btn-label">
                {isSignedIn ? 'Account' : 'Sign in'}
              </span>
            </button>
            <button
              type="button"
              className="sb-header-btn"
              onClick={() => setIsSettingsOpen(true)}
              aria-label="Settings and backups"
            >
              <SettingsIcon className="sb-header-btn-icon" />
              <span className="sb-header-btn-label">Settings</span>
            </button>
          </div>
        </div>
      </header>

      {settings?.hasDemoData && (
        <div className="sb-demo-banner">
          <div className="sb-demo-banner-inner">
            <span>
              Sample <strong>[DEMO]</strong> records are loaded for training.
              They are kept separate from real shop records.
            </span>
            <button
              type="button"
              className="sb-btn sb-btn-sm"
              onClick={() => setIsSampleDataOpen(true)}
            >
              Manage sample data
            </button>
          </div>
        </div>
      )}

      {/* Multi-Device Offline Stock Conflict Recount Notice */}
      {openConflicts.map((conflict) => (
        <div key={conflict.id} className="sb-demo-banner" role="alert">
          <div className="sb-demo-banner-inner">
            <span>
              <strong>Please recount {conflict.productName}:</strong> an offline
              sale of {conflict.requestedDeductionQty} was recorded while the
              server showed {conflict.serverQtyBefore} in stock. The sale was
              kept and stock set to 0.
            </span>
            <div className="sb-banner-actions">
              <button
                type="button"
                className="sb-btn sb-btn-sm"
                onClick={() => handleRestockProduct(conflict.productId)}
              >
                Recount stock
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

      <main className="sb-main" id="sb-main-content">
        {loadError && (
          <div className="sb-alert sb-alert-error" role="alert" aria-live="assertive">
            <div className="sb-alert-content">
              <strong>Could not open your records.</strong> {loadError}
            </div>
          </div>
        )}

        {isInitialLoading ? (
          <div className="sb-card sb-loading-card" role="status" aria-live="polite">
            <span className="sb-spinner" aria-hidden="true" />
            Opening the records saved on this phone…
          </div>
        ) : (
          <>
            {activeTab === 'home' && (
              <HomeScreen
                shopName={settings?.shopName ?? 'My Shop'}
                products={activeProducts}
                customers={customers}
                showWelcomeSetup={showWelcomeSetup}
                refreshToken={refreshToken}
                isSignedIn={isSignedIn}
                pendingOutboxCount={pendingOutboxCount}
                isSyncing={isSyncing}
                apiReachable={apiReachable}
                onSaveShopName={handleSaveShopName}
                onRecordSale={() => setActiveTab('sell')}
                onAddProduct={handleGoToAddProduct}
                onViewCredit={() => setActiveTab('credit')}
                onRestockProduct={handleRestockProduct}
                onOpenSettings={() => setIsSettingsOpen(true)}
                onOpenAccount={() => {
                  void reloadLocalStores();
                  setIsAccountModalOpen(true);
                }}
                onOpenSampleData={() => setIsSampleDataOpen(true)}
              />
            )}

            {/* Keep SellScreen mounted so an in-progress cart is preserved if the owner checks Stock or Credit */}
            <div style={{ display: activeTab === 'sell' ? 'block' : 'none' }}>
              <SellScreen
                products={activeProducts}
                customers={customers}
                onGoToAddProduct={handleGoToAddProduct}
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

            {activeTab === 'reports' && (
              <ReportsScreen
                refreshToken={refreshToken}
                onRestockProduct={handleRestockProduct}
                onOpenSettings={() => setIsSettingsOpen(true)}
              />
            )}
          </>
        )}
      </main>

      <nav className="sb-bottom-nav" aria-label="Primary navigation">
        <div className="sb-bottom-nav-inner">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const badge = navBadge(item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`sb-nav-tab ${activeTab === item.id ? 'is-active' : ''}`}
                aria-current={activeTab === item.id ? 'page' : undefined}
                onClick={() => setActiveTab(item.id)}
              >
                {badge && (
                  <span
                    className={`sb-nav-badge ${badge.tone === 'warn' ? 'is-warn' : ''}`}
                  >
                    {badge.count}
                  </span>
                )}
                <Icon className="sb-nav-icon" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <AccountSyncModal
        isOpen={isAccountModalOpen}
        localShopName={settings?.shopName ?? 'My Shop'}
        session={session}
        syncOverview={syncOverview}
        isSyncing={isSyncing}
        apiReachable={apiReachable}
        onClose={() => setIsAccountModalOpen(false)}
        onSessionChanged={(nextSess) => setSession(nextSess)}
        onTriggerSync={handleExplicitSync}
        onDataChanged={reloadAllData}
      />

      {settings && (
        <ShopSettingsModal
          isOpen={isSettingsOpen}
          settings={settings}
          isSignedIn={isSignedIn}
          pendingOutboxCount={pendingOutboxCount}
          apiReachable={apiReachable}
          onClose={() => setIsSettingsOpen(false)}
          onSaveShopName={handleSaveShopName}
          onOpenSampleData={() => {
            setIsSettingsOpen(false);
            setIsSampleDataOpen(true);
          }}
          onOpenAccount={() => {
            setIsSettingsOpen(false);
            setIsAccountModalOpen(true);
          }}
          onDataChanged={reloadAllData}
        />
      )}

      <SampleDataModal
        isOpen={isSampleDataOpen}
        hasDemoData={Boolean(settings?.hasDemoData)}
        hasRealRecords={realRecordsExist}
        realProductCount={realProductCount}
        onClose={() => setIsSampleDataOpen(false)}
        onLoadSampleData={handleLoadDemo}
        onRemoveSampleData={handleRemoveDemo}
      />
    </div>
  );
};
