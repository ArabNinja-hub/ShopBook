import React, { useEffect, useMemo, useState } from 'react';
import { createId, formatDateTimeReadable } from '../domain/ids';
import {
  formatNgwee,
  formatNgweePlain,
  parseKwachaToNgwee,
  parseOptionalKwachaToNgwee,
  parseWholeUnits,
} from '../domain/money';
import { Product, StockMovement } from '../domain/types';
import {
  adjustProductStock,
  createProduct,
  DEFAULT_LOW_STOCK_THRESHOLD,
  setProductArchived,
  StockAdjustmentMode,
  updateProduct,
} from '../services/stockService';

interface StockScreenProps {
  allProducts: Product[];
  recentMovements: StockMovement[];
  initialAddModalOpen?: boolean;
  initialAdjustProductId?: string | null;
  onConsumedInitialIntent: () => void;
  onDataChanged: () => Promise<void>;
}

type StockFilter = 'active' | 'low' | 'archived';

export const StockScreen: React.FC<StockScreenProps> = ({
  allProducts,
  recentMovements,
  initialAddModalOpen = false,
  initialAdjustProductId = null,
  onConsumedInitialIntent,
  onDataChanged,
}) => {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StockFilter>('active');
  const [showMovements, setShowMovements] = useState(false);

  // Add / Edit Product modal state
  const [isProductModalOpen, setIsProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productOpId, setProductOpId] = useState<string>(() => createId('op'));
  const [nameInput, setNameInput] = useState('');
  const [unitInput, setUnitInput] = useState('');
  const [sellingPriceInput, setSellingPriceInput] = useState('');
  const [costPriceInput, setCostPriceInput] = useState('');
  const [initialQtyInput, setInitialQtyInput] = useState('0');
  const [thresholdInput, setThresholdInput] = useState(
    String(DEFAULT_LOW_STOCK_THRESHOLD)
  );
  const [isSavingProduct, setIsSavingProduct] = useState(false);

  // Stock Adjustment modal state
  const [adjustTarget, setAdjustTarget] = useState<Product | null>(null);
  const [adjustOpId, setAdjustOpId] = useState<string>(() => createId('op'));
  const [adjustMode, setAdjustMode] = useState<StockAdjustmentMode>('add');
  const [adjustQtyInput, setAdjustQtyInput] = useState('');
  const [adjustReasonInput, setAdjustReasonInput] = useState('');
  const [isSavingAdjustment, setIsSavingAdjustment] = useState(false);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const openAddModal = () => {
    setEditingProduct(null);
    setProductOpId(createId('op'));
    setNameInput('');
    setUnitInput('');
    setSellingPriceInput('');
    setCostPriceInput('');
    setInitialQtyInput('0');
    setThresholdInput(String(DEFAULT_LOW_STOCK_THRESHOLD));
    setErrorMessage(null);
    setIsProductModalOpen(true);
  };

  const openEditModal = (product: Product) => {
    setEditingProduct(product);
    setNameInput(product.name);
    setUnitInput(product.unitLabel);
    setSellingPriceInput(formatNgweePlain(product.sellingPriceNgwee));
    setCostPriceInput(
      product.costPriceNgwee !== null
        ? formatNgweePlain(product.costPriceNgwee)
        : ''
    );
    setThresholdInput(String(product.lowStockThreshold));
    setErrorMessage(null);
    setIsProductModalOpen(true);
  };

  const openAdjustModal = (product: Product, mode: StockAdjustmentMode = 'add') => {
    setAdjustTarget(product);
    setAdjustOpId(createId('op'));
    setAdjustMode(mode);
    setAdjustQtyInput(mode === 'set' ? String(product.stockQty) : '');
    setAdjustReasonInput('');
    setErrorMessage(null);
  };

  useEffect(() => {
    if (initialAddModalOpen) {
      openAddModal();
      onConsumedInitialIntent();
    } else if (initialAdjustProductId) {
      const target = allProducts.find((p) => p.id === initialAdjustProductId);
      if (target) {
        openAdjustModal(target, 'add');
      }
      onConsumedInitialIntent();
    }
  }, [initialAddModalOpen, initialAdjustProductId, allProducts]);

  const counts = useMemo(() => {
    let active = 0;
    let low = 0;
    let archived = 0;
    for (const p of allProducts) {
      if (p.isArchived) {
        archived += 1;
      } else {
        active += 1;
        if (p.stockQty <= p.lowStockThreshold) {
          low += 1;
        }
      }
    }
    return { active, low, archived };
  }, [allProducts]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allProducts.filter((p) => {
      if (filter === 'active' && p.isArchived) return false;
      if (filter === 'archived' && !p.isArchived) return false;
      if (
        filter === 'low' &&
        (p.isArchived || p.stockQty > p.lowStockThreshold)
      ) {
        return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.unitLabel.toLowerCase().includes(q)
      );
    });
  }, [allProducts, filter, search]);

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingProduct) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSavingProduct(true);

    try {
      const sellingPriceNgwee = parseKwachaToNgwee(sellingPriceInput, {
        fieldLabel: 'Selling price',
        allowZero: false,
      });
      const costPriceNgwee = parseOptionalKwachaToNgwee(
        costPriceInput,
        'Cost price'
      );
      const lowStockThreshold = parseWholeUnits(thresholdInput, {
        fieldLabel: 'Low-stock alert threshold',
        allowZero: true,
      });

      if (editingProduct) {
        const updated = await updateProduct(editingProduct.id, {
          name: nameInput,
          unitLabel: unitInput,
          sellingPriceNgwee,
          costPriceNgwee,
          lowStockThreshold,
        });
        setStatusMessage(`Updated "${updated.name}".`);
      } else {
        const initialStockQty = parseWholeUnits(initialQtyInput, {
          fieldLabel: 'Opening stock quantity',
          allowZero: true,
        });
        const created = await createProduct({
          operationId: productOpId,
          name: nameInput,
          unitLabel: unitInput,
          sellingPriceNgwee,
          costPriceNgwee,
          initialStockQty,
          lowStockThreshold,
        });
        setStatusMessage(
          `Added "${created.name}" (${created.stockQty} in stock).`
        );
      }

      setIsProductModalOpen(false);
      await onDataChanged();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not save product.'
      );
    } finally {
      setIsSavingProduct(false);
    }
  };

  const handleToggleArchive = async (product: Product) => {
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const nextArchived = !product.isArchived;
      await setProductArchived(product.id, nextArchived);
      setIsProductModalOpen(false);
      setStatusMessage(
        nextArchived
          ? `Archived "${product.name}". Past sales remain preserved.`
          : `Restored "${product.name}" to active stock.`
      );
      await onDataChanged();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not update archive status.'
      );
    }
  };

  const handleSaveStockAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustTarget || isSavingAdjustment) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSavingAdjustment(true);

    try {
      const qty = parseWholeUnits(adjustQtyInput, {
        fieldLabel:
          adjustMode === 'set' ? 'Exact stock count' : 'Adjustment quantity',
        allowZero: adjustMode === 'set',
      });

      const { product } = await adjustProductStock({
        operationId: adjustOpId,
        productId: adjustTarget.id,
        mode: adjustMode,
        quantity: qty,
        reason: adjustReasonInput,
      });

      setStatusMessage(
        `Stock updated for "${product.name}": now ${product.stockQty} in stock.`
      );
      setAdjustTarget(null);
      await onDataChanged();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to adjust stock.'
      );
    } finally {
      setIsSavingAdjustment(false);
    }
  };

  const previewAdjustedStock = useMemo(() => {
    if (!adjustTarget) return null;
    const trimmed = adjustQtyInput.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) return null;
    if (adjustMode === 'add') return adjustTarget.stockQty + parsed;
    if (adjustMode === 'subtract') return adjustTarget.stockQty - parsed;
    return parsed;
  }, [adjustTarget, adjustMode, adjustQtyInput]);

  const isCostAboveSellingWarning = useMemo(() => {
    try {
      const sell = parseKwachaToNgwee(sellingPriceInput, { allowZero: false });
      const cost = parseOptionalKwachaToNgwee(costPriceInput);
      return cost !== null && cost > sell;
    } catch {
      return false;
    }
  }, [sellingPriceInput, costPriceInput]);

  return (
    <div>
      {statusMessage && (
        <div className="sb-alert sb-alert-success" role="status">
          <span>{statusMessage}</span>
          <button
            type="button"
            className="sb-btn sb-btn-sm"
            onClick={() => setStatusMessage(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {errorMessage && !isProductModalOpen && !adjustTarget && (
        <div className="sb-alert sb-alert-error" role="alert">
          <span>{errorMessage}</span>
          <button
            type="button"
            className="sb-btn sb-btn-sm"
            onClick={() => setErrorMessage(null)}
          >
            Close
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <div className="sb-search-wrap">
          <input
            type="search"
            className="sb-input"
            placeholder="Search stock items..."
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
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={openAddModal}
        >
          + Add Product
        </button>
      </div>

      <div className="sb-pills">
        <button
          type="button"
          className={`sb-pill ${filter === 'active' ? 'is-active' : ''}`}
          onClick={() => setFilter('active')}
        >
          Active ({counts.active})
        </button>
        <button
          type="button"
          className={`sb-pill ${filter === 'low' ? 'is-active' : ''}`}
          onClick={() => setFilter('low')}
        >
          Low Stock ({counts.low})
        </button>
        <button
          type="button"
          className={`sb-pill ${filter === 'archived' ? 'is-active' : ''}`}
          onClick={() => setFilter('archived')}
        >
          Archived ({counts.archived})
        </button>
      </div>

      {filteredProducts.length === 0 ? (
        <div className="sb-card" style={{ textAlign: 'center', padding: 22 }}>
          <p style={{ margin: '0 0 12px', color: 'var(--sb-text-muted)' }}>
            {filter === 'low'
              ? 'Good news — no active products are low on stock.'
              : filter === 'archived'
                ? 'No archived products.'
                : 'No products found. Add your shop products to start tracking stock.'}
          </p>
          {filter === 'active' && !search && (
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={openAddModal}
            >
              + Add First Product
            </button>
          )}
        </div>
      ) : (
        <div className="sb-product-list" style={{ marginBottom: 14 }}>
          {filteredProducts.map((product) => {
            const isOut = product.stockQty === 0;
            const isLow =
              !product.isArchived &&
              !isOut &&
              product.stockQty <= product.lowStockThreshold;

            return (
              <div key={product.id} className="sb-product-row" style={{ flexWrap: 'wrap' }}>
                <div className="sb-product-info" style={{ minWidth: 200 }}>
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
                      Sell: {formatNgwee(product.sellingPriceNgwee)}
                    </span>
                    <span>
                      {product.costPriceNgwee !== null
                        ? `Cost: ${formatNgwee(product.costPriceNgwee)}`
                        : 'Cost: not set'}
                    </span>
                    {product.isArchived ? (
                      <span className="sb-badge">Archived</span>
                    ) : isOut ? (
                      <span className="sb-badge sb-badge-out">
                        0 in stock (Out)
                      </span>
                    ) : isLow ? (
                      <span className="sb-badge sb-badge-low">
                        Low: {product.stockQty} left (alert ≤{' '}
                        {product.lowStockThreshold})
                      </span>
                    ) : (
                      <span className="sb-badge sb-badge-ok">
                        {product.stockQty} in stock
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  {!product.isArchived && (
                    <button
                      type="button"
                      className="sb-btn sb-btn-primary sb-btn-sm"
                      onClick={() => openAdjustModal(product, 'add')}
                    >
                      Adjust Stock
                    </button>
                  )}
                  <button
                    type="button"
                    className="sb-btn sb-btn-sm"
                    onClick={() => openEditModal(product)}
                  >
                    Edit
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Collapsible Stock Movement Audit Trail */}
      <div className="sb-card">
        <div className="sb-row-between">
          <div>
            <h2 className="sb-card-title">Recent Stock Movements</h2>
            <p className="sb-card-subtitle">
              Audit trail of restocks, sales deductions, and recounts
            </p>
          </div>
          <button
            type="button"
            className="sb-btn sb-btn-sm"
            onClick={() => setShowMovements((v) => !v)}
          >
            {showMovements ? 'Hide Log' : `Show Log (${recentMovements.length})`}
          </button>
        </div>

        {showMovements && (
          <div style={{ marginTop: 12 }}>
            {recentMovements.length === 0 ? (
              <p style={{ margin: 0, color: 'var(--sb-text-muted)', fontSize: '0.88rem' }}>
                No stock movements recorded yet.
              </p>
            ) : (
              <div className="sb-list-divider">
                {recentMovements.slice(0, 25).map((m) => (
                  <div key={m.id} className="sb-row-between">
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                        {m.productNameSnapshot}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--sb-text-muted)' }}>
                        {formatDateTimeReadable(m.createdAt)} · {m.reason}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div
                        style={{
                          fontWeight: 800,
                          color:
                            m.deltaQty > 0
                              ? 'var(--sb-green-700)'
                              : m.deltaQty < 0
                                ? 'var(--sb-red-text)'
                                : 'var(--sb-text)',
                        }}
                      >
                        {m.deltaQty > 0 ? `+${m.deltaQty}` : m.deltaQty}
                      </div>
                      <div style={{ fontSize: '0.76rem', color: 'var(--sb-text-muted)' }}>
                        {m.previousQty} → {m.newQty}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add / Edit Product Modal */}
      {isProductModalOpen && (
        <div
          className="sb-modal-backdrop"
          onClick={() => !isSavingProduct && setIsProductModalOpen(false)}
        >
          <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-header">
              <h2 className="sb-modal-title">
                {editingProduct ? 'Edit Product' : 'Add New Product'}
              </h2>
              <button
                type="button"
                className="sb-close-btn"
                disabled={isSavingProduct}
                onClick={() => setIsProductModalOpen(false)}
                aria-label="Close modal"
              >
                ×
              </button>
            </div>

            {errorMessage && (
              <div className="sb-alert sb-alert-error" role="alert">
                <span>{errorMessage}</span>
              </div>
            )}

            <form onSubmit={handleSaveProduct}>
              <div className="sb-field">
                <label className="sb-label" htmlFor="prod-name">
                  Product Name *
                </label>
                <input
                  id="prod-name"
                  type="text"
                  className="sb-input"
                  placeholder="e.g. Cooking Oil 2L"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  required
                />
              </div>

              <div className="sb-field">
                <label className="sb-label" htmlFor="prod-unit">
                  Unit or Pack Size (optional)
                </label>
                <input
                  id="prod-unit"
                  type="text"
                  className="sb-input"
                  placeholder="e.g. 2L bottle, 2kg bag, loaf, bar"
                  value={unitInput}
                  onChange={(e) => setUnitInput(e.target.value)}
                />
              </div>

              <div className="sb-grid-2">
                <div className="sb-field">
                  <label className="sb-label" htmlFor="prod-sell">
                    Selling Price (Kwacha) *
                  </label>
                  <input
                    id="prod-sell"
                    type="text"
                    inputMode="decimal"
                    className="sb-input"
                    placeholder="e.g. 12.50"
                    value={sellingPriceInput}
                    onChange={(e) => setSellingPriceInput(e.target.value)}
                    required
                  />
                </div>

                <div className="sb-field">
                  <label className="sb-label" htmlFor="prod-cost">
                    Cost Price (Kwacha, optional)
                  </label>
                  <input
                    id="prod-cost"
                    type="text"
                    inputMode="decimal"
                    className="sb-input"
                    placeholder="e.g. 9.50"
                    value={costPriceInput}
                    onChange={(e) => setCostPriceInput(e.target.value)}
                  />
                </div>
              </div>
              <span className="sb-hint" style={{ marginTop: -6, marginBottom: 12 }}>
                Recording cost price lets ShopBook estimate gross profit on sales.
              </span>

              {isCostAboveSellingWarning && (
                <div className="sb-alert sb-alert-warn" style={{ marginBottom: 12 }}>
                  <span>
                    <strong>Check prices:</strong> Cost price is higher than
                    selling price. Make sure the two prices were not swapped
                    unless selling below cost intentionally.
                  </span>
                </div>
              )}

              <div className="sb-grid-2">
                {!editingProduct && (
                  <div className="sb-field">
                    <label className="sb-label" htmlFor="prod-qty">
                      Opening Quantity in Stock *
                    </label>
                    <input
                      id="prod-qty"
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      className="sb-input"
                      value={initialQtyInput}
                      onChange={(e) => setInitialQtyInput(e.target.value)}
                      required
                    />
                  </div>
                )}

                <div className="sb-field">
                  <label className="sb-label" htmlFor="prod-threshold">
                    Low-Stock Warning At
                  </label>
                  <input
                    id="prod-threshold"
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    className="sb-input"
                    value={thresholdInput}
                    onChange={(e) => setThresholdInput(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="sb-btn"
                  disabled={isSavingProduct}
                  onClick={() => setIsProductModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="sb-btn sb-btn-primary sb-btn-block"
                  disabled={isSavingProduct}
                >
                  {isSavingProduct
                    ? 'Saving...'
                    : editingProduct
                      ? 'Save Changes'
                      : 'Add Product'}
                </button>
              </div>
            </form>

            {editingProduct && (
              <div
                style={{
                  marginTop: 16,
                  paddingTop: 12,
                  borderTop: '1px solid var(--sb-border)',
                }}
              >
                <div className="sb-row-between">
                  <span style={{ fontSize: '0.82rem', color: 'var(--sb-text-muted)' }}>
                    {editingProduct.isArchived
                      ? 'Restore this item to show it on the Sell screen again.'
                      : 'Archive hides this item from selling while keeping past sales intact.'}
                  </span>
                  <button
                    type="button"
                    className={`sb-btn sb-btn-sm ${editingProduct.isArchived ? '' : 'sb-btn-danger'}`}
                    onClick={() => handleToggleArchive(editingProduct)}
                  >
                    {editingProduct.isArchived ? 'Restore Product' : 'Archive'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Stock Adjustment Modal */}
      {adjustTarget && (
        <div
          className="sb-modal-backdrop"
          onClick={() => !isSavingAdjustment && setAdjustTarget(null)}
        >
          <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sb-modal-header">
              <h2 className="sb-modal-title">
                Adjust Stock — {adjustTarget.name}
              </h2>
              <button
                type="button"
                className="sb-close-btn"
                disabled={isSavingAdjustment}
                onClick={() => setAdjustTarget(null)}
                aria-label="Close modal"
              >
                ×
              </button>
            </div>

            {errorMessage && (
              <div className="sb-alert sb-alert-error" role="alert">
                <span>{errorMessage}</span>
              </div>
            )}

            <div
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--sb-radius-sm)',
                backgroundColor: 'var(--sb-surface-subtle)',
                border: '1px solid var(--sb-border)',
                marginBottom: 12,
                fontSize: '0.9rem',
              }}
            >
              Current Stock: <strong>{adjustTarget.stockQty}</strong>
              {previewAdjustedStock !== null && (
                <>
                  {' '}
                  → New Stock:{' '}
                  <strong
                    style={{
                      color:
                        previewAdjustedStock < 0
                          ? 'var(--sb-red-text)'
                          : 'var(--sb-green-700)',
                    }}
                  >
                    {previewAdjustedStock}
                  </strong>
                </>
              )}
            </div>

            <form onSubmit={handleSaveStockAdjustment}>
              <div className="sb-field">
                <span className="sb-label">Adjustment Type</span>
                <div className="sb-pay-grid">
                  <button
                    type="button"
                    className={`sb-pay-option ${adjustMode === 'add' ? 'is-selected' : ''}`}
                    onClick={() => {
                      setAdjustMode('add');
                      setAdjustQtyInput('');
                    }}
                  >
                    + Add Stock
                  </button>
                  <button
                    type="button"
                    className={`sb-pay-option ${adjustMode === 'subtract' ? 'is-selected' : ''}`}
                    onClick={() => {
                      setAdjustMode('subtract');
                      setAdjustQtyInput('');
                    }}
                  >
                    − Remove
                  </button>
                  <button
                    type="button"
                    className={`sb-pay-option ${adjustMode === 'set' ? 'is-selected' : ''}`}
                    onClick={() => {
                      setAdjustMode('set');
                      setAdjustQtyInput(String(adjustTarget.stockQty));
                    }}
                  >
                    = Set Count
                  </button>
                </div>
              </div>

              <div className="sb-field">
                <label className="sb-label" htmlFor="adj-qty">
                  {adjustMode === 'add'
                    ? 'Units Received (to add) *'
                    : adjustMode === 'subtract'
                      ? 'Units to Remove *'
                      : 'Exact Physical Stock Count *'}
                </label>
                <input
                  id="adj-qty"
                  type="number"
                  min={adjustMode === 'set' ? 0 : 1}
                  step={1}
                  inputMode="numeric"
                  className="sb-input"
                  placeholder="Enter whole units"
                  value={adjustQtyInput}
                  onChange={(e) => setAdjustQtyInput(e.target.value)}
                  required
                />
              </div>

              <div className="sb-field">
                <label className="sb-label" htmlFor="adj-reason">
                  Reason / Note (optional)
                </label>
                <input
                  id="adj-reason"
                  type="text"
                  className="sb-input"
                  placeholder={
                    adjustMode === 'add'
                      ? 'e.g. Bought from wholesaler'
                      : adjustMode === 'subtract'
                        ? 'e.g. Damaged / spoiled'
                        : 'e.g. Evening shelf count'
                  }
                  value={adjustReasonInput}
                  onChange={(e) => setAdjustReasonInput(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="sb-btn"
                  disabled={isSavingAdjustment}
                  onClick={() => setAdjustTarget(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="sb-btn sb-btn-primary sb-btn-block"
                  disabled={
                    isSavingAdjustment ||
                    (previewAdjustedStock !== null && previewAdjustedStock < 0)
                  }
                >
                  {isSavingAdjustment ? 'Updating...' : 'Save Stock Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
