import React, { useState } from 'react';
import { Banner } from './ui/Banner';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Modal } from './ui/Modal';

interface SampleDataModalProps {
  isOpen: boolean;
  hasDemoData: boolean;
  hasRealRecords: boolean;
  realProductCount: number;
  onClose: () => void;
  onLoadSampleData: () => Promise<void>;
  onRemoveSampleData: () => Promise<void>;
}

/**
 * Training-only sample data lives in its own screen, deliberately away from the
 * daily selling flow. Real shop records are never replaced: sample records are
 * tagged `isDemo` and removal only ever deletes those tagged records.
 */
export const SampleDataModal: React.FC<SampleDataModalProps> = ({
  isOpen,
  hasDemoData,
  hasRealRecords,
  realProductCount,
  onClose,
  onLoadSampleData,
  onRemoveSampleData,
}) => {
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const resetMessages = () => {
    setError(null);
    setFeedback(null);
  };

  const runLoad = async () => {
    setIsBusy(true);
    resetMessages();
    try {
      await onLoadSampleData();
      setConfirmLoad(false);
      setFeedback('Sample shop data loaded. Every sample record starts with [DEMO].');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not load sample data.'
      );
      setConfirmLoad(false);
    } finally {
      setIsBusy(false);
    }
  };

  const runRemove = async () => {
    setIsBusy(true);
    resetMessages();
    try {
      await onRemoveSampleData();
      setConfirmRemove(false);
      setFeedback('All [DEMO] sample records were removed. Real records were not touched.');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not remove sample data.'
      );
      setConfirmRemove(false);
    } finally {
      setIsBusy(false);
    }
  };

  const handleLoadClick = () => {
    resetMessages();
    if (hasRealRecords) {
      setConfirmLoad(true);
      return;
    }
    void runLoad();
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Sample shop data"
        closeLabel="Close sample data"
        dismissible={!isBusy}
      >
        <Banner tone="info">
          <strong>For training and demonstrations only.</strong> Sample records
          are labelled <strong>[DEMO]</strong> so they are never mistaken for
          real sales, stock or customers.
        </Banner>

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

        {hasDemoData ? (
          <>
            <p className="sb-body-text">
              Sample data is currently loaded. You can remove it at any time.
              Only records marked <strong>[DEMO]</strong> are deleted — your real
              products, sales and customers stay exactly as they are.
            </p>
            <button
              type="button"
              className="sb-btn sb-btn-danger sb-btn-block"
              disabled={isBusy}
              onClick={() => {
                resetMessages();
                setConfirmRemove(true);
              }}
            >
              Remove sample data
            </button>
          </>
        ) : (
          <>
            <p className="sb-body-text">
              Loading sample data adds example products, a few sales and two
              credit customers so you can practise safely.
            </p>
            {hasRealRecords ? (
              <Banner tone="warning">
                This shop already has real records
                {realProductCount > 0
                  ? ` (${realProductCount} ${realProductCount === 1 ? 'product' : 'products'})`
                  : ''}
                . Sample records are added alongside them and are clearly marked;
                nothing you have recorded will be deleted or changed.
              </Banner>
            ) : null}
            <button
              type="button"
              className="sb-btn sb-btn-primary sb-btn-block"
              disabled={isBusy}
              onClick={handleLoadClick}
            >
              {isBusy ? 'Loading…' : 'Load sample shop data'}
            </button>
          </>
        )}
      </Modal>

      <ConfirmDialog
        isOpen={confirmLoad}
        title="Add sample records?"
        message={
          <>
            <p>
              This adds <strong>[DEMO]</strong> products, sales and customers to
              your shop.
            </p>
            <p>
              Your existing real records are not deleted or changed. You can
              remove all sample records later in one step.
            </p>
          </>
        }
        confirmLabel="Add sample records"
        onConfirm={() => void runLoad()}
        onCancel={() => setConfirmLoad(false)}
        isBusy={isBusy}
      />

      <ConfirmDialog
        isOpen={confirmRemove}
        title="Remove sample records?"
        message={
          <p>
            This permanently deletes every record marked <strong>[DEMO]</strong>.
            Real products, sales, customers and credit balances are not touched.
          </p>
        }
        confirmLabel="Remove sample records"
        tone="danger"
        onConfirm={() => void runRemove()}
        onCancel={() => setConfirmRemove(false)}
        isBusy={isBusy}
      />
    </>
  );
};
