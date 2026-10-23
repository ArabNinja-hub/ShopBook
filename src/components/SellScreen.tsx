import React, { useEffect, useMemo, useState } from 'react';
import { createId } from '../domain/ids';
import { formatNgwee } from '../domain/money';
import {
  CustomerCreditSummary,
  Product,
  SalePaymentMethod,
} from '../domain/types';
import { createCustomer } from '../services/creditService';
import { recordSale } from '../services/salesService';

interface SellScreenProps {
  products: Product[];
  customers: CustomerCreditSummary[];
  showWelcomeSetup: boolean;
  shopName: string;
  onSaveShopName: (name: string) => Promise<void>;
  onGoToAddProduct: () => void;
  onLoadDemoData: () => Promise<void>;
  onOpenBackupModal: () => void;
  onDataChanged: () => Promise<void>;
  onCartCountChange: (totalUnits: number) => void;
}

export const SellScreen: React.FC<SellScreenProps> = ({
  products,
  customers,
  showWelcomeSetup,
  shopName,
  onSaveShopName,
  onGoToAddProduct,
  onLoadDemoData,
  onOpenBackupModal,
  onDataChanged,
  onCartCountChange,
}) => {
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [checkoutOpId, setCheckoutOpId] = useState<string>(() => createId('op'));
  const [isMobileCheckoutOpen, setIsMobileCheckoutOpen] = useState(false);

  const [paymentMethod, setPaymentMethod] = useState<SalePaymentMethod>('cash');
  const [paymentReference, setPaymentReference] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [saleNote, setSaleNote] = useState('');

  // Inline quick-add customer when selling on credit
  const [showQuickAddCustomer, setShowQuickAddCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [isSavingCustomer, setIsSavingCustomer] = useState(false);

  // Welcome setup shop name input
  const [welcomeNameInput, setWelcomeNameInput] = useState(shopName);
  const [isSavingWelcomeName, setIsSavingWelcomeName] = useState(false);

  const [isSubmittingSale, setIsSubmittingSale] = useState(false);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const productById = useMemo(
    () => new Map(products.map((p) => [p.id, p])),
    [products]
  );

  // Keep welcome shop-name input in sync when settings load or a backup is restored
  useEffect(() => {
    setWelcomeNameInput(shopName);
  }, [shopName]);

  // Reconcile in-progress cart if products are archived, restocked/reduced, or replaced via backup/demo
  useEffect(() => {
    let changed = false;
    const nextCart: Record<string, number> = {};

    for (const [productId, qty] of Object.entries(cart)) {
      const prod = productById.get(productId);
      if (!prod || prod.stockQty <= 0 || qty <= 0) {
        changed = true;
        continue;
      }
      if (qty > prod.stockQty) {
        nextCart[productId] = prod.stockQty;
        changed = true;
      } else {
        nextCart[productId] = qty;
      }
    }

    if (changed) {
      setCart(nextCart);
      setCheckoutOpId(createId('op'));
      const nextUnits = Object.values(nextCart).reduce((sum, q) => sum + q, 0);
      onCartCountChange(nextUnits);
      if (nextUnits === 0) {
        setIsMobileCheckoutOpen(false);
      }
    }
  }, [cart, productById, onCartCountChange]);

  // Clear selected credit customer if customer list changed and selected customer no longer exists
  useEffect(() => {
    if (
      selectedCustomerId &&
      !customers.some((c) => c.customer.id === selectedCustomerId)
    ) {
      setSelectedCustomerId('');
    }
  }, [customers, selectedCustomerId]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.unitLabel.toLowerCase().includes(q)
    );
  }, [products, search]);

  const cartLines = useMemo(() => {
    const lines: Array<{
      product: Product;
      quantity: number;
      lineTotalNgwee: number;
    }> = [];
    for (const [productId, qty] of Object.entries(cart)) {
      if (qty <= 0) continue;
      const product = productById.get(productId);
      if (!product) continue;
      lines.push({
        product,
        quantity: qty,
        lineTotalNgwee: product.sellingPriceNgwee * qty,
      });
    }
    return lines;
  }, [cart, productById]);

  const cartTotalUnits = useMemo(
    () => cartLines.reduce((sum, l) => sum + l.quantity, 0),
    [cartLines]
  );

  const cartTotalNgwee = useMemo(
    () => cartLines.reduce((sum, l) => sum + l.lineTotalNgwee, 0),
    [cartLines]
  );

  const updateCartState = (nextCart: Record<string, number>) => {
    setCart(nextCart);
    setCheckoutOpId(createId('op'));
    setErrorBanner(null);
    const units = Object.values(nextCart).reduce((sum, q) => sum + q, 0);
    onCartCountChange(units);
  };

  const adjustCartQty = (product: Product, delta: number) => {
    setSuccessBanner(null);
    const current = cart[product.id] ?? 0;
    const next = current + delta;

    if (next <= 0) {
      const copy = { ...cart };
      delete copy[product.id];
      updateCartState(copy);
      return;
    }

    if (next > product.stockQty) {
      setErrorBanner(
        `Only ${product.stockQty} in stock for "${product.name}".`
      );
      return;
    }

    updateCartState({
      ...cart,
      [product.id]: next,
    });
  };

  const clearCart = () => {
    updateCartState({});
    setPaymentMethod('cash');
    setPaymentReference('');
    setSelectedCustomerId('');
    setSaleNote('');
    setIsMobileCheckoutOpen(false);
  };

  const handleQuickCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingCustomer) return;
    setErrorBanner(null);
    setIsSavingCustomer(true);
    try {
      const created = await createCustomer({
        name: newCustomerName,
        phone: newCustomerPhone,
      });
      await onDataChanged();
      setSelectedCustomerId(created.id);
      setNewCustomerName('');
      setNewCustomerPhone('');
      setShowQuickAddCustomer(false);
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Could not save customer.'
      );
    } finally {
      setIsSavingCustomer(false);
    }
  };

  const handleConfirmSale = async () => {
    if (isSubmittingSale) return;
    setErrorBanner(null);
    setSuccessBanner(null);
    setIsSubmittingSale(true);

    try {
      const recorded = await recordSale({
        operationId: checkoutOpId,
        items: cartLines.map((l) => ({
          productId: l.product.id,
          quantity: l.quantity,
        })),
        paymentMethod,
        paymentReference:
          paymentMethod === 'mobile_money' ? paymentReference : null,
        customerId: paymentMethod === 'credit' ? selectedCustomerId : null,
        note: saleNote,
      });

      const methodLabel =
        recorded.paymentMethod === 'cash'
          ? 'Cash'
          : recorded.paymentMethod === 'mobile_money'
            ? 'Mobile Money (manual)'
            : `Credit — ${recorded.customerNameSnapshot ?? ''}`;

      setSuccessBanner(
        `Sale ${recorded.receiptNumber} saved: ${formatNgwee(recorded.totalNgwee)} (${methodLabel}).`
      );
      clearCart();
      await onDataChanged();
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Failed to record sale.'
      );
    } finally {
      setIsSubmittingSale(false);
    }
  };

  const selectedCustomerSummary = useMemo(
    () => customers.find((c) => c.customer.id === selectedCustomerId) ?? null,
    [customers, selectedCustomerId]
  );

  const renderCheckoutBody = () => {
    if (cartLines.length === 0) {
      return (
        <div style={{ color: 'var(--sb-text-muted)', fontSize: '0.9rem', padding: '12px 0' }}>
          Tap any product to add it to the current sale.
        </div>
      );
    }

    return (
      <div>
        <div className="sb-list-divider" style={{ marginBottom: 14 }}>
          {cartLines.map(({ product, quantity, lineTotalNgwee }) => (
            <div key={product.id} className="sb-row-between">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: '0.92rem' }}>
                  {product.name}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--sb-text-muted)' }}>
                  {formatNgwee(product.sellingPriceNgwee)} each ·{' '}
                  {formatNgwee(lineTotalNgwee)}
                </div>
              </div>
              <div className="sb-stepper">
                <button
                  type="button"
                  className="sb-step-btn"
                  aria-label={`Decrease ${product.name}`}
                  onClick={() => adjustCartQty(product, -1)}
                >
                  −
                </button>
                <span className="sb-step-qty">{quantity}</span>
                <button
                  type="button"
                  className="sb-step-btn"
                  aria-label={`Increase ${product.name}`}
                  disabled={quantity >= product.stockQty}
                  onClick={() => adjustCartQty(product, 1)}
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>

        <div
          className="sb-row-between"
          style={{
            padding: '10px 12px',
            borderRadius: 'var(--sb-radius-sm)',
            backgroundColor: 'var(--sb-green-100)',
            border: '1px solid var(--sb-green-200)',
            marginBottom: 14,
          }}
        >
          <span style={{ fontWeight: 700 }}>
            Cart Total ({cartTotalUnits} {cartTotalUnits === 1 ? 'item' : 'items'})
          </span>
          <span
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: 'var(--sb-pine-900)',
            }}
          >
            {formatNgwee(cartTotalNgwee)}
          </span>
        </div>

        <div className="sb-field">
          <span className="sb-label">Payment Method</span>
          <div className="sb-pay-grid">
            <button
              type="button"
              className={`sb-pay-option ${paymentMethod === 'cash' ? 'is-selected' : ''}`}
              onClick={() => setPaymentMethod('cash')}
            >
              Cash
            </button>
            <button
              type="button"
              className={`sb-pay-option ${paymentMethod === 'mobile_money' ? 'is-selected' : ''}`}
              onClick={() => setPaymentMethod('mobile_money')}
            >
              Mobile Money
            </button>
            <button
              type="button"
              className={`sb-pay-option ${paymentMethod === 'credit' ? 'is-selected' : ''}`}
              onClick={() => setPaymentMethod('credit')}
            >
              Credit Book
            </button>
          </div>
        </div>

        {paymentMethod === 'mobile_money' && (
          <div className="sb-field">
            <div className="sb-alert sb-alert-warn" style={{ marginBottom: 8 }}>
              <span>
                <strong>Manual record only:</strong> ShopBook does not process
                MTN MoMo or Airtel Money electronically. Confirm you received
                payment on your phone first.
              </span>
            </div>
            <label className="sb-label" htmlFor="momo-ref">
              Network or Reference Note (optional)
            </label>
            <input
              id="momo-ref"
              type="text"
              className="sb-input"
              placeholder="e.g. Airtel Money / MTN MoMo"
              value={paymentReference}
              onChange={(e) => setPaymentReference(e.target.value)}
            />
          </div>
        )}

        {paymentMethod === 'credit' && (
          <div className="sb-field">
            <div className="sb-row-between" style={{ marginBottom: 4 }}>
              <label className="sb-label" htmlFor="credit-customer" style={{ margin: 0 }}>
                Customer Buying on Credit *
              </label>
              <button
                type="button"
                className="sb-btn sb-btn-sm"
                onClick={() => setShowQuickAddCustomer((v) => !v)}
              >
                {showQuickAddCustomer ? 'Cancel' : '+ New Customer'}
              </button>
            </div>

            {showQuickAddCustomer ? (
              <div
                style={{
                  border: '1px solid var(--sb-border)',
                  borderRadius: 'var(--sb-radius-sm)',
                  padding: 10,
                  backgroundColor: 'var(--sb-surface-subtle)',
                  marginBottom: 8,
                }}
              >
                <div className="sb-field">
                  <label className="sb-label" htmlFor="quick-cust-name">
                    Customer Name *
                  </label>
                  <input
                    id="quick-cust-name"
                    type="text"
                    className="sb-input"
                    placeholder="e.g. Mama Chanda"
                    value={newCustomerName}
                    onChange={(e) => setNewCustomerName(e.target.value)}
                  />
                </div>
                <div className="sb-field">
                  <label className="sb-label" htmlFor="quick-cust-phone">
                    Phone Number (optional)
                  </label>
                  <input
                    id="quick-cust-phone"
                    type="tel"
                    className="sb-input"
                    placeholder="e.g. 0977..."
                    value={newCustomerPhone}
                    onChange={(e) => setNewCustomerPhone(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="sb-btn sb-btn-primary sb-btn-sm"
                  disabled={isSavingCustomer}
                  onClick={handleQuickCreateCustomer}
                >
                  {isSavingCustomer ? 'Saving...' : 'Save & Select Customer'}
                </button>
              </div>
            ) : (
              <select
                id="credit-customer"
                className="sb-select"
                value={selectedCustomerId}
                onChange={(e) => setSelectedCustomerId(e.target.value)}
              >
                <option value="">-- Choose customer --</option>
                {customers.map((c) => (
                  <option key={c.customer.id} value={c.customer.id}>
                    {c.customer.name} (Owes{' '}
                    {formatNgwee(c.outstandingBalanceNgwee)})
                  </option>
                ))}
              </select>
            )}

            {selectedCustomerSummary && (
              <div className="sb-hint">
                Current balance:{' '}
                <strong>
                  {formatNgwee(selectedCustomerSummary.outstandingBalanceNgwee)}
                </strong>{' '}
                → New balance after this sale:{' '}
                <strong>
                  {formatNgwee(
                    selectedCustomerSummary.outstandingBalanceNgwee +
                      cartTotalNgwee
                  )}
                </strong>
              </div>
            )}
          </div>
        )}

        <div className="sb-field">
          <label className="sb-label" htmlFor="sale-note">
            Sale Note (optional)
          </label>
          <input
            id="sale-note"
            type="text"
            className="sb-input"
            placeholder="Optional note"
            value={saleNote}
            onChange={(e) => setSaleNote(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="sb-btn"
            disabled={isSubmittingSale}
            onClick={clearCart}
          >
            Clear
          </button>
          <button
            type="button"
            className="sb-btn sb-btn-primary sb-btn-block"
            disabled={
              isSubmittingSale ||
              (paymentMethod === 'credit' && !selectedCustomerId)
            }
            onClick={handleConfirmSale}
          >
            {isSubmittingSale
              ? 'Recording Sale...'
              : `Confirm Sale · ${formatNgwee(cartTotalNgwee)}`}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div>
      {successBanner && (
        <div className="sb-alert sb-alert-success" role="status">
          <span>
            <strong>Saved:</strong> {successBanner}
          </span>
          <button
            type="button"
            className="sb-btn sb-btn-sm"
            onClick={() => setSuccessBanner(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {errorBanner && (
        <div className="sb-alert sb-alert-error" role="alert">
          <span>{errorBanner}</span>
          <button
            type="button"
            className="sb-btn sb-btn-sm"
            onClick={() => setErrorBanner(null)}
          >
            Close
          </button>
        </div>
      )}

      {showWelcomeSetup && (
        <div className="sb-welcome-card">
          <img
            src={`${import.meta.env.BASE_URL}brand/shopbook-logo.png`}
            alt="ShopBook — Smarter Sales. Better Business."
            className="sb-logo-full"
          />
          <h1 style={{ fontSize: '1.15rem', margin: '0 0 6px' }}>
            Welcome to ShopBook
          </h1>
          <p
            style={{
              margin: '0 auto 14px',
              maxWidth: 460,
              fontSize: '0.88rem',
              color: 'var(--sb-text-muted)',
            }}
          >
            Fast, reliable sales, stock, and customer credit records in Zambian
            Kwacha — stored right on your device even when mobile data is off.
          </p>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setErrorBanner(null);
              setIsSavingWelcomeName(true);
              try {
                await onSaveShopName(welcomeNameInput);
              } catch (err) {
                setErrorBanner(
                  err instanceof Error ? err.message : 'Could not save shop name.'
                );
              } finally {
                setIsSavingWelcomeName(false);
              }
            }}
            style={{
              maxWidth: 400,
              margin: '0 auto 14px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <input
              type="text"
              className="sb-input"
              style={{ flex: '1 1 190px' }}
              aria-label="Shop name"
              placeholder="Enter your shop name (e.g. Chanda General)"
              value={welcomeNameInput}
              onChange={(e) => setWelcomeNameInput(e.target.value)}
            />
            <button
              type="submit"
              className="sb-btn"
              style={{ flex: '0 0 auto' }}
              disabled={isSavingWelcomeName}
            >
              Save Name
            </button>
          </form>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              justifyContent: 'center',
            }}
          >
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={onGoToAddProduct}
            >
              + Add Your First Product
            </button>
            <button
              type="button"
              className="sb-btn"
              onClick={onLoadDemoData}
            >
              Try Sample [DEMO] Shop
            </button>
            <button
              type="button"
              className="sb-btn"
              onClick={onOpenBackupModal}
            >
              Restore JSON Backup
            </button>
          </div>
        </div>
      )}

      <div className="sb-sell-layout">
        <div className="sb-sell-products">
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <div className="sb-search-wrap">
              <input
                type="search"
                className="sb-input"
                placeholder="Search products to sell..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  type="button"
                  className="sb-search-clear"
                  aria-label="Clear search"
                  onClick={() => setSearch('')}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {products.length === 0 ? (
            <div className="sb-card" style={{ textAlign: 'center', padding: 24 }}>
              <p style={{ margin: '0 0 12px', color: 'var(--sb-text-muted)' }}>
                No active products in stock yet. Add products in the Stock tab
                to begin recording sales.
              </p>
              <button
                type="button"
                className="sb-btn sb-btn-primary"
                onClick={onGoToAddProduct}
              >
                + Add Product in Stock
              </button>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="sb-card" style={{ textAlign: 'center' }}>
              No products match &ldquo;{search}&rdquo;.
            </div>
          ) : (
            <div className="sb-product-list">
              {filteredProducts.map((product) => {
                const qtyInCart = cart[product.id] ?? 0;
                const isOut = product.stockQty <= 0;
                const isLow =
                  !isOut && product.stockQty <= product.lowStockThreshold;

                return (
                  <div
                    key={product.id}
                    className={`sb-product-row ${qtyInCart > 0 ? 'in-cart' : ''} ${isOut ? 'is-out' : ''}`}
                  >
                    <div className="sb-product-info">
                      <div className="sb-product-name">
                        {product.name}
                        {product.unitLabel ? (
                          <span
                            style={{
                              fontWeight: 500,
                              color: 'var(--sb-text-muted)',
                              fontSize: '0.84rem',
                              marginLeft: 6,
                            }}
                          >
                            ({product.unitLabel})
                          </span>
                        ) : null}
                      </div>
                      <div className="sb-product-meta">
                        <span className="sb-price-tag">
                          {formatNgwee(product.sellingPriceNgwee)}
                        </span>
                        {isOut ? (
                          <span className="sb-badge sb-badge-out">
                            Out of stock
                          </span>
                        ) : isLow ? (
                          <span className="sb-badge sb-badge-low">
                            Low: {product.stockQty} left
                          </span>
                        ) : (
                          <span className="sb-badge sb-badge-ok">
                            {product.stockQty} in stock
                          </span>
                        )}
                      </div>
                    </div>

                    {qtyInCart > 0 ? (
                      <div className="sb-stepper">
                        <button
                          type="button"
                          className="sb-step-btn"
                          aria-label={`Remove one ${product.name}`}
                          onClick={() => adjustCartQty(product, -1)}
                        >
                          −
                        </button>
                        <span className="sb-step-qty">{qtyInCart}</span>
                        <button
                          type="button"
                          className="sb-step-btn is-add"
                          aria-label={`Add one more ${product.name}`}
                          disabled={qtyInCart >= product.stockQty}
                          onClick={() => adjustCartQty(product, 1)}
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="sb-btn sb-btn-primary sb-btn-sm"
                        style={{ minWidth: 82, minHeight: 42 }}
                        disabled={isOut}
                        onClick={() => adjustCartQty(product, 1)}
                      >
                        {isOut ? 'Sold Out' : '+ Sell'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Side-by-side Checkout Card on Desktop */}
        <aside className="sb-desktop-cart-panel">
          <div className="sb-card">
            <div className="sb-card-header">
              <h2 className="sb-card-title">Current Sale Cart</h2>
              {cartLines.length > 0 && (
                <span className="sb-badge sb-badge-ok">
                  {cartTotalUnits} {cartTotalUnits === 1 ? 'item' : 'items'}
                </span>
              )}
            </div>
            {renderCheckoutBody()}
          </div>
        </aside>
      </div>

      {/* Sticky Bottom Checkout Bar on Mobile */}
      {cartLines.length > 0 && !isMobileCheckoutOpen && (
        <div className="sb-sticky-cart-bar">
          <div className="sb-sticky-cart-inner">
            <div>
              <div style={{ fontSize: '0.78rem', color: '#bfe3ce' }}>
                {cartTotalUnits} {cartTotalUnits === 1 ? 'item' : 'items'} in
                cart
              </div>
              <div style={{ fontSize: '1.18rem', fontWeight: 800 }}>
                {formatNgwee(cartTotalNgwee)}
              </div>
            </div>
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={() => setIsMobileCheckoutOpen(true)}
            >
              Checkout &amp; Confirm →
            </button>
          </div>
        </div>
      )}

      {/* Mobile Checkout Sheet */}
      {isMobileCheckoutOpen && (
        <div
          className="sb-modal-backdrop"
          onClick={() => !isSubmittingSale && setIsMobileCheckoutOpen(false)}
        >
          <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-header">
              <h2 className="sb-modal-title">Confirm Sale</h2>
              <button
                type="button"
                className="sb-close-btn"
                disabled={isSubmittingSale}
                onClick={() => setIsMobileCheckoutOpen(false)}
                aria-label="Close checkout"
              >
                ×
              </button>
            </div>
            {errorBanner && (
              <div className="sb-alert sb-alert-error" role="alert">
                <span>{errorBanner}</span>
              </div>
            )}
            {renderCheckoutBody()}
          </div>
        </div>
      )}
    </div>
  );
};
