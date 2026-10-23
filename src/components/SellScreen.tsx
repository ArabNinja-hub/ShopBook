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
import { Banner } from './ui/Banner';
import { Modal } from './ui/Modal';
import { PlusIcon, SellIcon } from './ui/icons';

interface SellScreenProps {
  products: Product[];
  customers: CustomerCreditSummary[];
  onGoToAddProduct: () => void;
  onDataChanged: () => Promise<void>;
  onCartCountChange: (totalUnits: number) => void;
}

const PAYMENT_OPTIONS: Array<{
  value: SalePaymentMethod;
  label: string;
  hint: string;
}> = [
  { value: 'cash', label: 'Cash', hint: 'Paid in full now' },
  { value: 'mobile_money', label: 'Mobile Money', hint: 'Recorded by hand' },
  { value: 'credit', label: 'Credit Book', hint: 'Customer pays later' },
];

/**
 * Record a sale. The cart stays mounted while the owner checks Stock or Credit
 * (see App.tsx) so an in-progress sale is never lost.
 */
export const SellScreen: React.FC<SellScreenProps> = ({
  products,
  customers,
  onGoToAddProduct,
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

  const [isSubmittingSale, setIsSubmittingSale] = useState(false);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const productById = useMemo(
    () => new Map(products.map((p) => [p.id, p])),
    [products]
  );

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
      setErrorBanner(`Only ${product.stockQty} in stock for "${product.name}".`);
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
            ? 'Mobile Money (recorded by hand)'
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
        <p className="sb-empty-text">
          Tap a product below to add it to this sale.
        </p>
      );
    }

    return (
      <div>
        <ul className="sb-list-divider sb-cart-list">
          {cartLines.map(({ product, quantity, lineTotalNgwee }) => (
            <li key={product.id} className="sb-cart-row">
              <div className="sb-cart-text">
                <span className="sb-cart-name">{product.name}</span>
                <span className="sb-cart-meta">
                  {formatNgwee(product.sellingPriceNgwee)} each ·{' '}
                  {formatNgwee(lineTotalNgwee)}
                </span>
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
                <span className="sb-step-qty" aria-live="polite">
                  {quantity}
                </span>
                <button
                  type="button"
                  className="sb-step-btn is-add"
                  aria-label={`Increase ${product.name}`}
                  disabled={quantity >= product.stockQty}
                  onClick={() => adjustCartQty(product, 1)}
                >
                  +
                </button>
              </div>
            </li>
          ))}
        </ul>

        <div className="sb-cart-total">
          <span className="sb-cart-total-label">
            Total
            <span className="sb-cart-total-units">
              {cartTotalUnits} {cartTotalUnits === 1 ? 'item' : 'items'}
            </span>
          </span>
          <span className="sb-cart-total-value">{formatNgwee(cartTotalNgwee)}</span>
        </div>

        <fieldset className="sb-fieldset">
          <legend className="sb-label">How is the customer paying?</legend>
          <div className="sb-pay-grid">
            {PAYMENT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`sb-pay-option ${paymentMethod === option.value ? 'is-selected' : ''}`}
                aria-label={option.label}
                aria-pressed={paymentMethod === option.value}
                onClick={() => setPaymentMethod(option.value)}
              >
                <span className="sb-pay-option-label">{option.label}</span>
                <span className="sb-pay-option-hint">{option.hint}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {paymentMethod === 'mobile_money' && (
          <div className="sb-field">
            <Banner tone="warning">
              ShopBook does not process MTN MoMo or Airtel Money. Check that the
              money arrived on your phone first, then record it here.
            </Banner>
            <label className="sb-label" htmlFor="momo-ref">
              Network or reference (optional)
            </label>
            <input
              id="momo-ref"
              type="text"
              className="sb-input"
              placeholder="e.g. Airtel Money / MTN MoMo"
              value={paymentReference}
              onChange={(event) => setPaymentReference(event.target.value)}
            />
          </div>
        )}

        {paymentMethod === 'credit' && (
          <div className="sb-field">
            <div className="sb-field-head">
              <label className="sb-label" htmlFor="credit-customer">
                Customer Buying on Credit
              </label>
              <button
                type="button"
                className="sb-link-btn"
                onClick={() => setShowQuickAddCustomer((value) => !value)}
              >
                {showQuickAddCustomer ? 'Cancel new customer' : 'New customer'}
              </button>
            </div>

            {showQuickAddCustomer ? (
              <div className="sb-inline-panel">
                <div className="sb-field">
                  <label className="sb-label" htmlFor="quick-cust-name">
                    Customer name
                  </label>
                  <input
                    id="quick-cust-name"
                    type="text"
                    className="sb-input"
                    placeholder="e.g. Mama Chanda"
                    value={newCustomerName}
                    onChange={(event) => setNewCustomerName(event.target.value)}
                  />
                </div>
                <div className="sb-field">
                  <label className="sb-label" htmlFor="quick-cust-phone">
                    Phone number (optional)
                  </label>
                  <input
                    id="quick-cust-phone"
                    type="tel"
                    className="sb-input"
                    placeholder="e.g. 0977…"
                    value={newCustomerPhone}
                    onChange={(event) => setNewCustomerPhone(event.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="sb-btn sb-btn-primary sb-btn-sm"
                  disabled={isSavingCustomer}
                  onClick={handleQuickCreateCustomer}
                >
                  {isSavingCustomer ? 'Saving…' : 'Save and select'}
                </button>
              </div>
            ) : (
              <select
                id="credit-customer"
                className="sb-select"
                value={selectedCustomerId}
                onChange={(event) => setSelectedCustomerId(event.target.value)}
              >
                <option value="">Choose a customer</option>
                {customers.map((c) => (
                  <option key={c.customer.id} value={c.customer.id}>
                    {c.customer.name} (owes{' '}
                    {formatNgwee(c.outstandingBalanceNgwee)})
                  </option>
                ))}
              </select>
            )}

            {selectedCustomerSummary && (
              <p className="sb-hint">
                They owe {formatNgwee(selectedCustomerSummary.outstandingBalanceNgwee)}{' '}
                now. After this sale they will owe{' '}
                <strong>
                  {formatNgwee(
                    selectedCustomerSummary.outstandingBalanceNgwee +
                      cartTotalNgwee
                  )}
                </strong>
                .
              </p>
            )}
          </div>
        )}

        <div className="sb-field">
          <label className="sb-label" htmlFor="sale-note">
            Note (optional)
          </label>
          <input
            id="sale-note"
            type="text"
            className="sb-input"
            placeholder="e.g. paid on Friday"
            value={saleNote}
            onChange={(event) => setSaleNote(event.target.value)}
          />
        </div>

        <div className="sb-dialog-actions">
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
              isSubmittingSale || (paymentMethod === 'credit' && !selectedCustomerId)
            }
            onClick={handleConfirmSale}
          >
            {isSubmittingSale
              ? 'Saving sale…'
              : `Confirm sale · ${formatNgwee(cartTotalNgwee)}`}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div>
      <header className="sb-page-head">
        <h1 className="sb-page-title">Record a sale</h1>
        <p className="sb-page-subtitle">
          Tap an item to add it, then confirm at the bottom.
        </p>
      </header>

      {successBanner && (
        <Banner tone="success" onDismiss={() => setSuccessBanner(null)}>
          <strong>Saved.</strong> {successBanner}
        </Banner>
      )}

      {errorBanner && (
        <Banner tone="error" onDismiss={() => setErrorBanner(null)}>
          {errorBanner}
        </Banner>
      )}

      <div className="sb-sell-layout">
        <div className="sb-sell-products">
          <div className="sb-search-wrap">
            <input
              type="search"
              className="sb-input"
              placeholder="Search products…"
              aria-label="Search products to sell"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
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

          {products.length === 0 ? (
            <div className="sb-card sb-empty-state">
              <h2 className="sb-card-title">No products yet</h2>
              <p className="sb-empty-text">
                Add a product with its price and how many you have, then you can
                start recording sales.
              </p>
              <button
                type="button"
                className="sb-btn sb-btn-primary"
                onClick={onGoToAddProduct}
              >
                Add a product
              </button>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="sb-card sb-empty-state">
              <h2 className="sb-card-title">No match</h2>
              <p className="sb-empty-text">
                Nothing in stock matches “{search}”.
              </p>
            </div>
          ) : (
            <ul className="sb-product-list">
              {filteredProducts.map((product) => {
                const qtyInCart = cart[product.id] ?? 0;
                const isOut = product.stockQty <= 0;
                const isLow =
                  !isOut && product.stockQty <= product.lowStockThreshold;

                return (
                  <li
                    key={product.id}
                    className={`sb-product-row ${qtyInCart > 0 ? 'in-cart' : ''} ${isOut ? 'is-out' : ''}`}
                  >
                    <div className="sb-product-info">
                      <div className="sb-product-name">
                        {product.name}
                        {product.unitLabel ? (
                          <span className="sb-product-unit">({product.unitLabel})</span>
                        ) : null}
                      </div>
                      <div className="sb-product-meta">
                        <span className="sb-price-tag">
                          {formatNgwee(product.sellingPriceNgwee)}
                        </span>
                        {isOut ? (
                          <span className="sb-badge sb-badge-out">Out of stock</span>
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
                        className="sb-btn sb-btn-primary sb-btn-sell"
                        aria-label={`Sell ${product.name}`}
                        disabled={isOut}
                        onClick={() => adjustCartQty(product, 1)}
                      >
                        {isOut ? (
                          'Sold out'
                        ) : (
                          <>
                            <PlusIcon className="sb-inline-icon" />
                            Sell
                          </>
                        )}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Side-by-side checkout card on desktop */}
        <aside className="sb-desktop-cart-panel">
          <div className="sb-card">
            <div className="sb-card-header">
              <h2 className="sb-card-title">This sale</h2>
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

      {/* Sticky bottom checkout bar on mobile */}
      {cartLines.length > 0 && !isMobileCheckoutOpen && (
        <div className="sb-sticky-cart-bar">
          <div className="sb-sticky-cart-inner">
            <div className="sb-sticky-cart-text">
              <span className="sb-sticky-cart-units">
                {cartTotalUnits} {cartTotalUnits === 1 ? 'item' : 'items'}
              </span>
              <span className="sb-sticky-cart-total">
                {formatNgwee(cartTotalNgwee)}
              </span>
            </div>
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={() => setIsMobileCheckoutOpen(true)}
            >
              Review &amp; confirm
            </button>
          </div>
        </div>
      )}

      <Modal
        isOpen={isMobileCheckoutOpen}
        onClose={() => setIsMobileCheckoutOpen(false)}
        title="Confirm sale"
        closeLabel="Close checkout"
        dismissible={!isSubmittingSale}
      >
        <div className="sb-mobile-checkout-summary">
          <SellIcon className="sb-inline-icon" />
          {cartTotalUnits} {cartTotalUnits === 1 ? 'item' : 'items'} ·{' '}
          <strong>{formatNgwee(cartTotalNgwee)}</strong>
        </div>
        {errorBanner && (
          <Banner tone="error" onDismiss={() => setErrorBanner(null)}>
            {errorBanner}
          </Banner>
        )}
        {renderCheckoutBody()}
      </Modal>
    </div>
  );
};
