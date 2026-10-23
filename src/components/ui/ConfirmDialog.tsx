import React from 'react';
import { Modal } from './Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  /** Plain-language description of exactly what will happen. */
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Use `danger` for destructive actions such as replacing records. */
  tone?: 'primary' | 'danger';
  isBusy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app replacement for `window.confirm` so destructive confirmations look and
 * behave like the rest of ShopBook (and are keyboard/screen-reader accessible).
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  isBusy = false,
  onConfirm,
  onCancel,
}) => (
  <Modal
    isOpen={isOpen}
    onClose={onCancel}
    title={title}
    closeLabel={cancelLabel}
    dismissible={!isBusy}
    panelClassName="sb-confirm-dialog"
  >
    <div className="sb-confirm-message">{message}</div>
    <div className="sb-dialog-actions">
      <button
        type="button"
        className="sb-btn"
        onClick={onCancel}
        disabled={isBusy}
      >
        {cancelLabel}
      </button>
      <button
        type="button"
        className={
          tone === 'danger'
            ? 'sb-btn sb-btn-danger sb-btn-block'
            : 'sb-btn sb-btn-primary sb-btn-block'
        }
        onClick={onConfirm}
        disabled={isBusy}
      >
        {isBusy ? 'Working…' : confirmLabel}
      </button>
    </div>
  </Modal>
);
