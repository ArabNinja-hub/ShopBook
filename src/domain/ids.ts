/**
 * Stable, collision-resistant ID and date helpers.
 * Uses the standard Web Crypto UUID generator (crypto.randomUUID)
 * with short readable prefixes so records are easy to identify in exports.
 */

export type IdPrefix = 'prd' | 'sal' | 'sli' | 'stk' | 'cus' | 'crd' | 'op';

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Formats a Date object as YYYY-MM-DD in the device's local timezone.
 * Using local dates ensures sales recorded at 23:30 in Zambia belong to today's
 * business day rather than rolling over early due to UTC offsets.
 */
export function toLocalDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Formats a local YYYY-MM-DD date string into a readable label, e.g. "23 Oct 2026".
 */
export function formatLocalDateLabel(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) return localDate;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${day} ${months[monthIndex] ?? match[2]} ${year}`;
}

/**
 * Formats an ISO timestamp into a short readable time like "14:05" or date+time.
 */
export function formatTimeShort(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatDateTimeReadable(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp;
  return `${formatLocalDateLabel(toLocalDateKey(d))} ${formatTimeShort(isoTimestamp)}`;
}

/**
 * Generates a short human-readable receipt code for a sale on a given local date,
 * e.g. "SB-20261023-004". Note: primary uniqueness is always enforced via `sale.id` (UUID).
 */
export function buildReceiptNumber(localDate: string, dailySequence: number): string {
  const compactDate = localDate.replace(/-/g, '');
  const seq = String(Math.max(1, dailySequence)).padStart(3, '0');
  return `SB-${compactDate}-${seq}`;
}

/**
 * Computes the next non-colliding `SB-YYYYMMDD-NNN` receipt number on `localDate`
 * by finding the highest existing numeric sequence rather than `sales.length + 1`
 * (which could collide if demo or imported sales were previously removed).
 */
export function nextDailyReceiptNumber(
  localDate: string,
  existingReceiptNumbers: string[]
): string {
  const compactDate = localDate.replace(/-/g, '');
  const prefix = `SB-${compactDate}-`;
  let maxSeq = 0;

  for (const code of existingReceiptNumbers) {
    if (code.startsWith(prefix)) {
      const suffix = code.slice(prefix.length);
      if (/^\d+$/.test(suffix)) {
        const num = Number(suffix);
        if (Number.isSafeInteger(num) && num > maxSeq) {
          maxSeq = num;
        }
      }
    }
  }

  return buildReceiptNumber(localDate, maxSeq + 1);
}
