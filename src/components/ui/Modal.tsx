import React, { useEffect, useId, useRef } from 'react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Accessible name for the close button, e.g. "Close settings". */
  closeLabel?: string;
  /** When false, Escape / backdrop taps are ignored (e.g. while saving). */
  dismissible?: boolean;
  children: React.ReactNode;
  /** Extra class names applied to the dialog panel. */
  panelClassName?: string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Accessible dialog used by every ShopBook modal.
 *
 * Provides the behaviour the previous hand-rolled modals were missing:
 * `role="dialog"`, `aria-modal`, a labelled title, Escape-to-close, Tab focus
 * trapping, focus restoration to the opener, and background scroll locking.
 * On phones it renders as a bottom sheet; from 640px up it is a centred card.
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  closeLabel = 'Close',
  dismissible = true,
  children,
  panelClassName,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);

  onCloseRef.current = onClose;
  dismissibleRef.current = dismissible;

  useEffect(() => {
    if (!isOpen) return undefined;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    const panel = panelRef.current;
    panel?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissibleRef.current) {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab' || !panelRef.current) return;

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((element) => element.tabIndex !== -1);

      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="sb-modal-backdrop"
      onClick={() => {
        if (dismissibleRef.current) onCloseRef.current();
      }}
    >
      <div
        className={`sb-modal${panelClassName ? ` ${panelClassName}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sb-modal-header">
          <h2 className="sb-modal-title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="sb-close-btn"
            aria-label={closeLabel}
            disabled={!dismissible}
            onClick={onClose}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="sb-modal-body">{children}</div>
      </div>
    </div>
  );
};
