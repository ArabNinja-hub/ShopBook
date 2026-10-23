import React, { useEffect, useRef, useState } from 'react';
import { formatDateTimeReadable, toLocalDateKey } from '../domain/ids';
import { ShopSettings } from '../domain/types';
import {
  createFullBackupJson,
  downloadTextFile,
  exportCreditTransactionsCsv,
  exportCustomerBalancesCsv,
  exportProductsCsv,
  exportSaleItemsCsv,
  exportSalesCsv,
  restoreBackupFromJson,
} from '../services/exportService';
import { getLocalSyncOverview } from '../services/syncClientService';

interface ShopSettingsModalProps {
  isOpen: boolean;
  settings: ShopSettings;
  onClose: () => void;
  onSaveShopName: (name: string) => Promise<void>;
  onLoadDemoData: () => Promise<void>;
  onRemoveDemoData: () => Promise<void>;
  onDataChanged: () => Promise<void>;
}

export const ShopSettingsModal: React.FC<ShopSettingsModalProps> = ({
  isOpen,
  settings,
  onClose,
  onSaveShopName,
  onLoadDemoData,
  onRemoveDemoData,
  onDataChanged,
}) => {
  const [nameInput, setNameInput] = useState(settings.shopName);
  const [isBusy, setIsBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Sync shop name input whenever settings update (e.g. after backup restore)
  useEffect(() => {
    setNameInput(settings.shopName);
  }, [settings.shopName]);

  // Clear old banners whenever modal is freshly opened
  useEffect(() => {
    if (isOpen) {
      setFeedback(null);
      setError(null);
      setNameInput(settings.shopName);
    }
  }, [isOpen, settings.shopName]);

  if (!isOpen) return null;

  const dateStamp = toLocalDateKey();

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      await onSaveShopName(nameInput);
      setFeedback('Shop name updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update shop name.');
    } finally {
      setIsBusy(false);
    }
  };

  const runDownload = async (
    label: string,
    filename: string,
    mime: string,
    generator: () => Promise<string>
  ) => {
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      const content = await generator();
      downloadTextFile(filename, content, mime);
      await onDataChanged();
      setFeedback(`Downloaded ${label} (${filename}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to export ${label}.`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleRestoreFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const syncCheck = await getLocalSyncOverview().catch(() => null);
    const pendingSyncNote =
      syncCheck && syncCheck.pendingOutboxCount > 0
        ? `\n\nWARNING: ${syncCheck.pendingOutboxCount} offline record(s) have NOT been synchronized to your cloud account yet and will be replaced!`
        : '';

    const confirmed = window.confirm(
      `Restore shop records from "${file.name}"?\n\nThis will replace the current records stored in this browser with the backup file.${pendingSyncNote}`
    );
    if (!confirmed) return;

    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      const rawJson = await file.text();
      const stats = await restoreBackupFromJson(rawJson);
      await onDataChanged();
      setFeedback(
        `Backup restored: ${stats.productsCount} products, ${stats.salesCount} sales, and ${stats.customersCount} customers.`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to restore JSON backup.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div
      className="sb-modal-backdrop"
      onClick={() => !isBusy && onClose()}
    >
      <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sb-modal-header">
          <h2 className="sb-modal-title">Shop Settings, Exports &amp; Backup</h2>
          <button
            type="button"
            className="sb-close-btn"
            disabled={isBusy}
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </div>

        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <img
            src={`${import.meta.env.BASE_URL}brand/shopbook-logo.png`}
            alt="ShopBook"
            style={{ width: 150, height: 'auto', display: 'inline-block' }}
          />
        </div>

        {feedback && (
          <div className="sb-alert sb-alert-success" role="status">
            <span>{feedback}</span>
          </div>
        )}

        {error && (
          <div className="sb-alert sb-alert-error" role="alert">
            <span>{error}</span>
          </div>
        )}

        {/* Shop Name */}
        <form onSubmit={handleSaveName} style={{ marginBottom: 16 }}>
          <label className="sb-label" htmlFor="settings-shop-name">
            Shop Display Name
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="settings-shop-name"
              type="text"
              className="sb-input"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              required
            />
            <button type="submit" className="sb-btn" disabled={isBusy}>
              Save
            </button>
          </div>
        </form>

        {/* Local Storage Warning & Backup Workflow */}
        <div className="sb-alert sb-alert-warn" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: '0.82rem' }}>
            <strong>Important — Local Device Storage:</strong>
            <div style={{ marginTop: 4 }}>
              Your records are currently saved inside this browser&apos;s local
              database (IndexedDB) so you can record sales without mobile data.
              However, clearing browser storage, resetting the phone, or losing
              the device will erase unbacked-up data.
            </div>
            <div style={{ marginTop: 4 }}>
              <strong>Recommended daily habit:</strong> Tap{' '}
              <em>Download Full Backup (JSON)</em> at closing time and save or
              send the file to Google Drive, email, or WhatsApp.
            </div>
          </div>
        </div>

        {/* Full JSON Backup & Restore */}
        <div style={{ marginBottom: 16 }}>
          <div className="sb-label">Full Shop Backup &amp; Recovery (JSON)</div>
          <div style={{ fontSize: '0.79rem', color: 'var(--sb-text-muted)', marginBottom: 8 }}>
            {settings.lastBackupAt
              ? `Last JSON backup: ${formatDateTimeReadable(settings.lastBackupAt)}`
              : 'No JSON backup downloaded yet.'}
          </div>

          <div className="sb-grid-2">
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              disabled={isBusy}
              onClick={() =>
                runDownload(
                  'Full JSON Backup',
                  `shopbook-backup-${dateStamp}.json`,
                  'application/json;charset=utf-8',
                  () => createFullBackupJson()
                )
              }
            >
              Download Backup (JSON)
            </button>

            <button
              type="button"
              className="sb-btn"
              disabled={isBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              Restore Backup (JSON)
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={handleRestoreFileChange}
          />
        </div>

        {/* Spreadsheet CSV Exports */}
        <div style={{ marginBottom: 16 }}>
          <div className="sb-label">Spreadsheet Exports (CSV for Excel / Sheets)</div>
          <div className="sb-grid-2">
            <button
              type="button"
              className="sb-btn sb-btn-sm"
              disabled={isBusy}
              onClick={() =>
                runDownload(
                  'Sales Receipts CSV',
                  `shopbook-sales-${dateStamp}.csv`,
                  'text/csv;charset=utf-8',
                  exportSalesCsv
                )
              }
            >
              Sales (CSV)
            </button>

            <button
              type="button"
              className="sb-btn sb-btn-sm"
              disabled={isBusy}
              onClick={() =>
                runDownload(
                  'Sale Items CSV',
                  `shopbook-sale-items-${dateStamp}.csv`,
                  'text/csv;charset=utf-8',
                  exportSaleItemsCsv
                )
              }
            >
              Sale Items (CSV)
            </button>

            <button
              type="button"
              className="sb-btn sb-btn-sm"
              disabled={isBusy}
              onClick={() =>
                runDownload(
                  'Products & Stock CSV',
                  `shopbook-products-${dateStamp}.csv`,
                  'text/csv;charset=utf-8',
                  exportProductsCsv
                )
              }
            >
              Products &amp; Stock (CSV)
            </button>

            <button
              type="button"
              className="sb-btn sb-btn-sm"
              disabled={isBusy}
              onClick={() =>
                runDownload(
                  'Customer Balances CSV',
                  `shopbook-customers-${dateStamp}.csv`,
                  'text/csv;charset=utf-8',
                  exportCustomerBalancesCsv
                )
              }
            >
              Customer Balances (CSV)
            </button>

            <button
              type="button"
              className="sb-btn sb-btn-sm"
              style={{ gridColumn: '1 / -1' }}
              disabled={isBusy}
              onClick={() =>
                runDownload(
                  'Credit Transactions CSV',
                  `shopbook-credit-history-${dateStamp}.csv`,
                  'text/csv;charset=utf-8',
                  exportCreditTransactionsCsv
                )
              }
            >
              Credit &amp; Repayment History (CSV)
            </button>
          </div>
        </div>

        {/* Sample Demo Data Controls */}
        <div
          style={{
            paddingTop: 12,
            borderTop: '1px solid var(--sb-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '0.8rem', color: 'var(--sb-text-muted)' }}>
            Development / training sample data:
          </span>
          {settings.hasDemoData ? (
            <button
              type="button"
              className="sb-btn sb-btn-danger sb-btn-sm"
              disabled={isBusy}
              onClick={async () => {
                setIsBusy(true);
                setError(null);
                try {
                  await onRemoveDemoData();
                  setFeedback('Removed all [DEMO] sample records.');
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : 'Failed to remove demo data.'
                  );
                } finally {
                  setIsBusy(false);
                }
              }}
            >
              Remove [DEMO] Data
            </button>
          ) : (
            <button
              type="button"
              className="sb-btn sb-btn-sm"
              disabled={isBusy}
              onClick={async () => {
                setIsBusy(true);
                setError(null);
                try {
                  await onLoadDemoData();
                  setFeedback('Loaded clearly marked [DEMO] sample data.');
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : 'Failed to load demo data.'
                  );
                } finally {
                  setIsBusy(false);
                }
              }}
            >
              Load Sample [DEMO] Data
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
