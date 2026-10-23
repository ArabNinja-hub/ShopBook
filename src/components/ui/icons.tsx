import React from 'react';

/**
 * Small, consistent 24×24 outline icon set (2px stroke, currentColor).
 * Inline on purpose: no icon font, no extra network request, no runtime cost.
 */
interface IconProps {
  className?: string;
}

const baseProps = {
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: 'false' as const,
};

export const HomeIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V21h13V9.5" />
    <path d="M9.75 21v-6h4.5v6" />
  </svg>
);

export const SellIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <circle cx="9" cy="20" r="1.4" />
    <circle cx="17" cy="20" r="1.4" />
    <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.6a1 1 0 0 0 1-.8L21 7H6" />
  </svg>
);

export const StockIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
    <path d="M3.3 7.8 12 12.5l8.7-4.7M12 22v-9.5" />
  </svg>
);

export const CreditIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    <path d="M9 7h6M9 11h6" />
  </svg>
);

export const ReportsIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <path d="M4 20V4h16v16z" />
    <path d="M8 16v-4M12 16V8M16 16v-6" />
  </svg>
);

export const SettingsIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.6 0z" />
  </svg>
);

export const UserIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);

export const PlusIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const ChevronRightIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const CheckIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <path d="M4 12.5 9.5 18 20 6.5" />
  </svg>
);

export const AlertIcon: React.FC<IconProps> = ({ className }) => (
  <svg {...baseProps} className={className}>
    <path d="M12 3.5 2.8 20h18.4L12 3.5z" />
    <path d="M12 9.5v5M12 17.5h.01" />
  </svg>
);
