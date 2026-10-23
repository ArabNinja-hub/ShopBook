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
import { Banner } from './ui/Banner';
import { Modal } from './ui/Modal';

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
  const [showProductDetails, setShowProductDetails] = useState(false);
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
    setShowProductDetails(false);
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
    setShowProductDetails(false);
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
        setStatusMessage(`Added "${created.name}" (${created.stockQty} in stock).`);
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
      <header className="sb-page-head">
        <h1 className="sb-page-title">Stock</h1>
        <p className="sb-page-subtitle">
          What you sell, the price and how many you have left.
        </p>
      </header>

      {statusMessage && (
        <Banner tone="success" onDismiss={() => setStatusMessage(null)}>
          {statusMessage}
        </Banner>
      )}

      {errorMessage && !isProductModalOpen && !adjustTarget && (
        <Banner tone="error" onDismiss={() => setErrorMessage(null)}>
          {errorMessage}
        </Banner>
      )}

      <div className="sb-toolbar">
        <div className="sb-search-wrap">
          <input
            type="search"
            className="sb-input"
            placeholder="Search stock…"
            aria-label="Search stock items"
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
        <button type="button" className="sb-btn sb-btn-primary" onClick={openAddModal}>
          Add product
        </button>
      </div>

      <div className="sb-pills" role="group" aria-label="Stock filters">
        <button
          type="button"
          className={`sb-pill ${filter === 'active' ? 'is-active' : ''}`}
          aria-pressed={filter === 'active'}
          onClick={() => setFilter('active')}
        >
          All ({counts.active})
        </button>
        <button
          type="button"
          className={`sb-pill ${filter === 'low' ? 'is-active' : ''}`}
          aria-pressed={filter === 'low'}
          onClick={() => setFilter('low')}
        >
          Running low ({counts.low})
        </button>
        <button
          type="button"
          className={`sb-pill ${filter === 'archived' ? 'is-active' : ''}`}
          aria-pressed={filter === 'archived'}
          onClick={() => setFilter('archived')}
        >
          Hidden ({counts.archived})
        </button>
      </div>

      {filteredProducts.length === 0 ? (
        <div className="sb-card sb-empty-state">
          <p className="sb-empty-text">
            {filter === 'low'
              ? 'Good news — no products are running low.'
              : filter === 'archived'
                ? 'Nothing has been hidden from selling.'
                : search
                  ? `No product matches “${search}”.`
                  : 'No products yet. Add what you sell to start tracking stock.'}
          </p>
          {filter === 'active' && !search && (
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={openAddModal}
            >
              Add product
            </button>
          )}
        </div>
      ) : (
        <ul className="sb-product-list">
          {filteredProducts.map((product) => {
            const isOut = product.stockQty === 0;
            const isLow =
              !product.isArchived &&
              !isOut &&
              product.stockQty <= product.lowStockThreshold;

            return (
              <li key={product.id} className="sb-product-row is-stock-row">
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
                    {product.isArchived ? (
                      <span className="sb-badge">Hidden</span>
                    ) : isOut ? (
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

                <div className="sb-row-actions">
                  {!product.isArchived && (
                    <button
                      type="button"
                      className="sb-btn sb-btn-primary sb-btn-sm"
                      onClick={() => openAdjustModal(product, 'add')}
                    >
                      Update stock
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
              </li>
            );
          })}
        </ul>
      )}

      <section className="sb-card sb-history-card">
        <div className="sb-card-header">
          <div>
            <h2 className="sb-card-title">Stock history</h2>
            <p className="sb-card-subtitle">
              Every restock, sale and recount, newest first.
            </p>
          </div>
          <button
            type="button"
            className="sb-btn sb-btn-sm"
            aria-expanded={showMovements}
            onClick={() => setShowMovements((value) => !value)}
          >
            {showMovements ? 'Hide' : `Show (${recentMovements.length})`}
          </button>
        </div>

        {showMovements &&
          (recentMovements.length === 0 ? (
            <p className="sb-empty-text">Nothing here yet.</p>
          ) : (
            <ul className="sb-list-divider">
              {recentMovements.slice(0, 25).map((movement) => (
                <li key={movement.id} className="sb-history-row">
                  <div className="sb-history-text">
                    <span className="sb-history-name">
                      {movement.productNameSnapshot}
                    </span>
                    <span className="sb-history-meta">
                      {formatDateTimeReadable(movement.createdAt)} ·{' '}
                      {movement.reason}
                    </span>
                  </div>
                  <div className="sb-history-change">
                    <span
                      className={
                        movement.deltaQty > 0
                          ? 'sb-history-delta is-up'
                          : 'sb-history-delta is-down'
                      }
                    >
                      {movement.deltaQty > 0
                        ? `+${movement.deltaQty}`
                        : movement.deltaQty}
                    </span>
                    <span className="sb-history-meta">
                      {movement.previousQty} → {movement.newQty}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ))}
      </section>

      <Modal
        isOpen={isProductModalOpen}
        onClose={() => setIsProductModalOpen(false)}
        title={editingProduct ? 'Edit product' : 'Add product'}
        closeLabel="Close modal"
        dismissible={!isSavingProduct}
      >
        {errorMessage && (
          <Banner tone="error" onDismiss={() => setErrorMessage(null)}>
            {errorMessage}
          </Banner>
        )}

        <form onSubmit={handleSaveProduct}>
          <div className="sb-field">
            <label className="sb-label" htmlFor="prod-name">
              Product name
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

          <div className="sb-grid-2">
            <div className="sb-field">
              <label className="sb-label" htmlFor="prod-sell">
                Selling Price (Kwacha)
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
              <label className="sb-label" htmlFor="prod-unit">
                Pack or unit (optional)
              </label>
              <input
                id="prod-unit"
                type="text"
                className="sb-input"
                placeholder="e.g. 2L bottle"
                value={unitInput}
                onChange={(e) => setUnitInput(e.target.value)}
              />
            </div>
          </div>

          {!editingProduct && (
            <div className="sb-field">
              <label className="sb-label" htmlFor="prod-qty">
                How many do you have now?
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

          <button
            type="button"
            className="sb-disclosure sb-disclosure-compact"
            aria-expanded={showProductDetails}
            onClick={() => setShowProductDetails((value) => !value)}
          >
            <span>More details</span>
            <span aria-hidden="true">{showProductDetails ? '−' : '+'}</span>
          </button>

          {showProductDetails && (
            <div className="sb-settings-more">
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
                <p className="sb-hint">
                  What you paid for it. Used only to estimate profit.
                </p>
              </div>

              <div className="sb-field">
                <label className="sb-label" htmlFor="prod-threshold">
                  Warn me when stock reaches
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
          )}

          {isCostAboveSellingWarning && (
            <Banner tone="warning">
              <strong>Check the prices:</strong> Cost price is higher than
              selling price. Make sure the two prices were not swapped.
            </Banner>
          )}

          <div className="sb-dialog-actions">
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
                ? 'Saving…'
                : editingProduct
                  ? 'Save changes'
                  : 'Add product'}
            </button>
          </div>
        </form>

        {editingProduct && (
          <div className="sb-archive-block">
            <p className="sb-hint">
              {editingProduct.isArchived
                ? 'Restore this product to sell it again.'
                : 'Hide this product from selling. Past sales are kept.'}
            </p>
            <button
              type="button"
              className={`sb-btn sb-btn-sm ${editingProduct.isArchived ? '' : 'sb-btn-danger'}`}
              onClick={() => handleToggleArchive(editingProduct)}
            >
              {editingProduct.isArchived ? 'Restore Product' : 'Archive'}
            </button>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={adjustTarget !== null}
        onClose={() => setAdjustTarget(null)}
        title={`Update stock${adjustTarget ? ` — ${adjustTarget.name}` : ''}`}
        closeLabel="Close modal"
        dismissible={!isSavingAdjustment}
      >
        {errorMessage && (
          <Banner tone="error" onDismiss={() => setErrorMessage(null)}>
            {errorMessage}
          </Banner>
        )}

        {adjustTarget && (
          <>
            <div className="sb-stock-preview">
              <span>
                Now: <strong>{adjustTarget.stockQty}</strong>
              </span>
              {previewAdjustedStock !== null && (
                <span>
                  After:{' '}
                  <strong
                    className={
                      previewAdjustedStock < 0 ? 'is-negative' : 'is-positive'
                    }
                  >
                    {previewAdjustedStock}
                  </strong>
                </span>
              )}
            </div>

            <form onSubmit={handleSaveStockAdjustment}>
              <fieldset className="sb-fieldset">
                <legend className="sb-label">What happened?</legend>
                <div className="sb-segment">
                  <button
                    type="button"
                    className={`sb-segment-btn ${adjustMode === 'add' ? 'is-selected' : ''}`}
                    aria-pressed={adjustMode === 'add'}
                    onClick={() => {
                      setAdjustMode('add');
                      setAdjustQtyInput('');
                    }}
                  >
                    + Add stock
                  </button>
                  <button
                    type="button"
                    className={`sb-segment-btn ${adjustMode === 'subtract' ? 'is-selected' : ''}`}
                    aria-pressed={adjustMode === 'subtract'}
                    onClick={() => {
                      setAdjustMode('subtract');
                      setAdjustQtyInput('');
                    }}
                  >
                    − Remove
                  </button>
                  <button
                    type="button"
                    className={`sb-segment-btn ${adjustMode === 'set' ? 'is-selected' : ''}`}
                    aria-pressed={adjustMode === 'set'}
                    onClick={() => {
                      setAdjustMode('set');
                      setAdjustQtyInput(String(adjustTarget.stockQty));
                    }}
                  >
                    Set exact count
                  </button>
                </div>
              </fieldset>

              <div className="sb-field">
                <label className="sb-label" htmlFor="adj-qty">
                  {adjustMode === 'add'
                    ? 'How many did you receive?'
                    : adjustMode === 'subtract'
                      ? 'How many are gone?'
                      : 'Exact stock count'}
                </label>
                <input
                  id="adj-qty"
                  type="number"
                  min={adjustMode === 'set' ? 0 : 1}
                  step={1}
                  inputMode="numeric"
                  className="sb-input"
                  placeholder="Whole units"
                  value={adjustQtyInput}
                  onChange={(e) => setAdjustQtyInput(e.target.value)}
                  required
                />
              </div>

              <div className="sb-field">
                <label className="sb-label" htmlFor="adj-reason">
                  Reason (optional)
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

              <div className="sb-dialog-actions">
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
                  {isSavingAdjustment ? 'Saving…' : 'Save stock change'}
                </button>
              </div>
            </form>
          </>
        )}
      </Modal>
    </div>
  );
};
