import React from 'react';

export type BannerTone = 'success' | 'error' | 'warning' | 'info';

interface BannerProps {
  tone: BannerTone;
  children: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Extra class names (spacing tweaks only — tone styling stays centralised). */
  className?: string;
}

const TONE_ROLE: Record<BannerTone, 'status' | 'alert'> = {
  success: 'status',
  info: 'status',
  warning: 'status',
  error: 'alert',
};

/**
 * Single banner used for success confirmations, warnings and errors.
 *
 * Success and warning banners are announced politely through `aria-live`;
 * errors are announced assertively. This replaces the previous mix of
 * `role="status"` banners with no live region at all.
 */
export const Banner: React.FC<BannerProps> = ({
  tone,
  children,
  onDismiss,
  dismissLabel = 'Dismiss',
  className,
}) => (
  <div
    className={`sb-alert sb-alert-${tone}${className ? ` ${className}` : ''}`}
    role={TONE_ROLE[tone]}
    aria-live={tone === 'error' ? 'assertive' : 'polite'}
  >
    <div className="sb-alert-content">{children}</div>
    {onDismiss && (
      <button
        type="button"
        className="sb-alert-dismiss"
        onClick={onDismiss}
        aria-label={dismissLabel}
      >
        Dismiss
      </button>
    )}
  </div>
);
