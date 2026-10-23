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
import { Banner } from './ui/Banner';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Modal } from './ui/Modal';

interface ShopSettingsModalProps {
  isOpen: boolean;
  settings: ShopSettings;
  isSignedIn: boolean;
  pendingOutboxCount: number;
  apiReachable: boolean | null;
  onClose: () => void;
  onSaveShopName: (name: string) => Promise<void>;
  onOpenSampleData: () => void;
  onOpenAccount: () => void;
  onDataChanged: () => Promise<void>;
}

export const ShopSettingsModal: React.FC<ShopSettingsModalProps> = ({
  isOpen,
  settings,
  isSignedIn,
  pendingOutboxCount,
  apiReachable,
  onClose,
  onSaveShopName,
  onOpenSampleData,
  onOpenAccount,
  onDataChanged,
}) => {
  const [nameInput, setNameInput] = useState(settings.shopName);
  const [isBusy, setIsBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(null);
  const [pendingSyncWarning, setPendingSyncWarning] = useState<string | null>(null);
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
      setShowMoreOptions(false);
      setNameInput(settings.shopName);
    }
  }, [isOpen, settings.shopName]);

  const dateStamp = toLocalDateKey();

  const handleSaveName = async (event: React.FormEvent) => {
    event.preventDefault();
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

  const handleRestoreFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError(null);
    setFeedback(null);

    const syncCheck = await getLocalSyncOverview().catch(() => null);
    setPendingSyncWarning(
      syncCheck && syncCheck.pendingOutboxCount > 0
        ? `${syncCheck.pendingOutboxCount} record(s) on this phone have not reached your cloud account yet and would be replaced.`
        : null
    );
    setPendingRestoreFile(file);
  };

  const runRestore = async () => {
    if (!pendingRestoreFile) return;
    setIsBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const rawJson = await pendingRestoreFile.text();
      const stats = await restoreBackupFromJson(rawJson);
      await onDataChanged();
      setFeedback(
        `Backup restored: ${stats.productsCount} products, ${stats.salesCount} sales and ${stats.customersCount} customers.`
      );
      setPendingRestoreFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore the backup file.');
      setPendingRestoreFile(null);
    } finally {
      setIsBusy(false);
    }
  };

  const storageSummary = isSignedIn
    ? pendingOutboxCount > 0
      ? `${pendingOutboxCount} record(s) are saved on this phone and still waiting to sync to your ShopBook account.`
      : 'Your records are saved on this phone and synced to your ShopBook account.'
    : 'Your records are saved on this phone only. If this phone is lost, reset or its browser storage is cleared, un-backed-up records are gone.';

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Settings"
        closeLabel="Close settings"
        dismissible={!isBusy}
      >
        {feedback && (
          <Banner tone="success" onDismiss={() => setFeedback(null)}>
            {feedback}
          </Banner>
        )}
        {error && (
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        )}

        <section className="sb-settings-section">
          <h3 className="sb-settings-title">Shop name</h3>
          <form onSubmit={handleSaveName}>
            <label className="sb-label" htmlFor="settings-shop-name">
              Shop Display Name
            </label>
            <div className="sb-inline-form">
              <input
                id="settings-shop-name"
                type="text"
                className="sb-input"
                value={nameInput}
                onChange={(event) => setNameInput(event.target.value)}
                required
              />
              <button type="submit" className="sb-btn" disabled={isBusy}>
                Save
              </button>
            </div>
            <p className="sb-hint">This is the name shown at the top of ShopBook.</p>
          </form>
        </section>

        <section className="sb-settings-section">
          <h3 className="sb-settings-title">Where your records are kept</h3>
          <p className="sb-body-text">{storageSummary}</p>
          {apiReachable === false && (
            <Banner tone="warning">
              The ShopBook server cannot be reached from this copy of the app, so
              cloud sync is unavailable. Sales, stock and credit still work and
              are saved on this phone.
            </Banner>
          )}
          <button type="button" className="sb-btn sb-btn-sm" onClick={onOpenAccount}>
            {isSignedIn ? 'Account & cloud sync' : 'Turn on cloud sync'}
          </button>
        </section>

        <section className="sb-settings-section">
          <h3 className="sb-settings-title">Back up your records</h3>
          <p className="sb-hint">
            {settings.lastBackupAt
              ? `Last backup downloaded: ${formatDateTimeReadable(settings.lastBackupAt)}`
              : 'No backup downloaded from this phone yet.'}
          </p>
          <button
            type="button"
            className="sb-btn sb-btn-primary sb-btn-block"
            disabled={isBusy}
            onClick={() =>
              runDownload(
                'full backup',
                `shopbook-backup-${dateStamp}.json`,
                'application/json;charset=utf-8',
                () => createFullBackupJson()
              )
            }
          >
            Download backup
          </button>
          <p className="sb-hint">
            Save the file to Google Drive, email or WhatsApp so a lost phone does
            not lose your records.
          </p>

          <h3 className="sb-settings-title sb-settings-title-spaced">
            Restore a backup
          </h3>
          <Banner tone="warning">
            Restoring replaces everything saved in this browser with the contents
            of the backup file.
          </Banner>
          <button
            type="button"
            className="sb-btn sb-btn-block"
            disabled={isBusy}
            onClick={() => fileInputRef.current?.click()}
          >
            Choose backup file
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="sb-visually-hidden"
            onChange={handleRestoreFileChange}
          />
        </section>

        <section className="sb-settings-section">
          <button
            type="button"
            className="sb-disclosure"
            aria-expanded={showMoreOptions}
            aria-controls="sb-settings-more"
            onClick={() => setShowMoreOptions((value) => !value)}
          >
            <span>More options</span>
            <span aria-hidden="true">{showMoreOptions ? '−' : '+'}</span>
          </button>

          {showMoreOptions && (
            <div id="sb-settings-more" className="sb-settings-more">
              <h3 className="sb-settings-title">Spreadsheet exports (CSV)</h3>
              <div className="sb-grid-2">
                <button
                  type="button"
                  className="sb-btn sb-btn-sm"
                  disabled={isBusy}
                  onClick={() =>
                    runDownload(
                      'sales CSV',
                      `shopbook-sales-${dateStamp}.csv`,
                      'text/csv;charset=utf-8',
                      exportSalesCsv
                    )
                  }
                >
                  Sales
                </button>
                <button
                  type="button"
                  className="sb-btn sb-btn-sm"
                  disabled={isBusy}
                  onClick={() =>
                    runDownload(
                      'sale items CSV',
                      `shopbook-sale-items-${dateStamp}.csv`,
                      'text/csv;charset=utf-8',
                      exportSaleItemsCsv
                    )
                  }
                >
                  Sale items
                </button>
                <button
                  type="button"
                  className="sb-btn sb-btn-sm"
                  disabled={isBusy}
                  onClick={() =>
                    runDownload(
                      'products CSV',
                      `shopbook-products-${dateStamp}.csv`,
                      'text/csv;charset=utf-8',
                      exportProductsCsv
                    )
                  }
                >
                  Products &amp; stock
                </button>
                <button
                  type="button"
                  className="sb-btn sb-btn-sm"
                  disabled={isBusy}
                  onClick={() =>
                    runDownload(
                      'customer balances CSV',
                      `shopbook-customers-${dateStamp}.csv`,
                      'text/csv;charset=utf-8',
                      exportCustomerBalancesCsv
                    )
                  }
                >
                  Customer balances
                </button>
                <button
                  type="button"
                  className="sb-btn sb-btn-sm sb-grid-span-2"
                  disabled={isBusy}
                  onClick={() =>
                    runDownload(
                      'credit history CSV',
                      `shopbook-credit-history-${dateStamp}.csv`,
                      'text/csv;charset=utf-8',
                      exportCreditTransactionsCsv
                    )
                  }
                >
                  Credit &amp; repayment history
                </button>
              </div>

              <h3 className="sb-settings-title sb-settings-title-spaced">
                Training data
              </h3>
              <p className="sb-hint">
                Practise with clearly marked <strong>[DEMO]</strong> products,
                sales and customers. Kept separate from your real records.
              </p>
              <button type="button" className="sb-btn sb-btn-sm" onClick={onOpenSampleData}>
                {settings.hasDemoData ? 'Manage sample data' : 'Load sample data'}
              </button>
            </div>
          )}
        </section>
      </Modal>

      <ConfirmDialog
        isOpen={pendingRestoreFile !== null}
        title="Replace the records on this phone?"
        message={
          <>
            <p>
              Restoring <strong>{pendingRestoreFile?.name}</strong> will replace
              everything currently saved in this browser with the contents of
              that file.
            </p>
            {pendingSyncWarning && (
              <p className="sb-confirm-warning">{pendingSyncWarning}</p>
            )}
            <p>This cannot be undone. Download a backup first if unsure.</p>
          </>
        }
        confirmLabel="Restore backup"
        tone="danger"
        isBusy={isBusy}
        onConfirm={() => void runRestore()}
        onCancel={() => {
          setPendingRestoreFile(null);
          setPendingSyncWarning(null);
        }}
      />
    </>
  );
};
