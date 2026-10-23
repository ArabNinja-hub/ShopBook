import { eq } from 'drizzle-orm';
import { EntitlementStatus, ShopEntitlementView } from '../../src/shared/syncTypes';
import { ServerConfig } from '../config';
import { AppDatabase, AppTransaction } from '../db/client';
import { billingPlans, shopEntitlements } from '../db/schema';

export interface RawEntitlementRecord {
  planCode: string;
  planName: string;
  status: EntitlementStatus;
  isPilotExempt: boolean;
  trialStartedAt: Date | null;
  trialEndsAt: Date | null;
  currentPeriodEndsAt: Date | null;
}

/**
 * Pure policy evaluator for ShopBook pilot & future trial/subscription states.
 *
 * Key rules:
 * 1. During Milestone 2 (`enforceSubscriptions = false`) or whenever `isPilotExempt = true`,
 *    shops receive full access (`allowNewSales = true`) and `showPaymentPrompt = false`.
 * 2. When subscription enforcement is eventually enabled in a future milestone for non-exempt shops,
 *    expired trials/plans transition to fair read-only mode (`allowNewSales = false`), while
 *    ALWAYS preserving `allowRepayments = true` and `allowExports = true` so historical records,
 *    customer debt collection, and CSV/JSON backups are never held hostage.
 */
export function evaluateEntitlementPolicy(
  record: RawEntitlementRecord,
  options: { enforceSubscriptions: boolean; now?: Date }
): ShopEntitlementView {
  const now = options.now ?? new Date();

  if (!options.enforceSubscriptions || record.isPilotExempt || record.status === 'pilot_free') {
    return {
      planCode: record.planCode,
      planName: record.planName,
      status: record.status,
      isPilotExempt: record.isPilotExempt,
      trialStartedAt: record.trialStartedAt?.toISOString() ?? null,
      trialEndsAt: record.trialEndsAt?.toISOString() ?? null,
      currentPeriodEndsAt: record.currentPeriodEndsAt?.toISOString() ?? null,
      allowNewSales: true,
      allowRepayments: true,
      allowExports: true,
      showPaymentPrompt: false,
      statusLabel: 'Free Pilot Access',
    };
  }

  const trialExpired =
    record.status === 'trialing' &&
    record.trialEndsAt !== null &&
    record.trialEndsAt.getTime() <= now.getTime();

  const periodExpired =
    record.status === 'active' &&
    record.currentPeriodEndsAt !== null &&
    record.currentPeriodEndsAt.getTime() <= now.getTime();

  const effectiveStatus: EntitlementStatus =
    trialExpired || periodExpired ? 'expired_read_only' : record.status;

  if (effectiveStatus === 'trialing' || effectiveStatus === 'active' || effectiveStatus === 'past_due') {
    return {
      planCode: record.planCode,
      planName: record.planName,
      status: effectiveStatus,
      isPilotExempt: false,
      trialStartedAt: record.trialStartedAt?.toISOString() ?? null,
      trialEndsAt: record.trialEndsAt?.toISOString() ?? null,
      currentPeriodEndsAt: record.currentPeriodEndsAt?.toISOString() ?? null,
      allowNewSales: true,
      allowRepayments: true,
      allowExports: true,
      showPaymentPrompt: effectiveStatus === 'past_due',
      statusLabel:
        effectiveStatus === 'trialing'
          ? 'Free Trial'
          : effectiveStatus === 'past_due'
            ? 'Grace Period'
            : 'Active Plan',
    };
  }

  return {
    planCode: record.planCode,
    planName: record.planName,
    status: effectiveStatus,
    isPilotExempt: false,
    trialStartedAt: record.trialStartedAt?.toISOString() ?? null,
    trialEndsAt: record.trialEndsAt?.toISOString() ?? null,
    currentPeriodEndsAt: record.currentPeriodEndsAt?.toISOString() ?? null,
    allowNewSales: false,
    allowRepayments: true,
    allowExports: true,
    showPaymentPrompt: true,
    statusLabel: 'Read-Only (Exports & Repayments Open)',
  };
}

export async function createInitialShopEntitlement(
  tx: AppTransaction,
  shopId: string,
  config: ServerConfig
): Promise<void> {
  await tx.insert(shopEntitlements).values({
    shopId,
    planCode: 'pilot_free',
    status: 'pilot_free',
    isPilotExempt: config.defaultPilotExempt,
    trialStartedAt: null,
    trialEndsAt: null,
    currentPeriodEndsAt: null,
    feeWaiverReason: config.defaultPilotExempt
      ? 'Initial free testing phase cohort'
      : null,
  });
}

export async function getShopEntitlementView(
  dbOrTx: AppDatabase | AppTransaction,
  shopId: string,
  config: ServerConfig
): Promise<ShopEntitlementView> {
  const rows = await dbOrTx
    .select({
      planCode: shopEntitlements.planCode,
      planName: billingPlans.name,
      status: shopEntitlements.status,
      isPilotExempt: shopEntitlements.isPilotExempt,
      trialStartedAt: shopEntitlements.trialStartedAt,
      trialEndsAt: shopEntitlements.trialEndsAt,
      currentPeriodEndsAt: shopEntitlements.currentPeriodEndsAt,
    })
    .from(shopEntitlements)
    .innerJoin(billingPlans, eq(shopEntitlements.planCode, billingPlans.code))
    .where(eq(shopEntitlements.shopId, shopId))
    .limit(1);

  if (rows.length === 0) {
    return evaluateEntitlementPolicy(
      {
        planCode: 'pilot_free',
        planName: 'Free Pilot Access',
        status: 'pilot_free',
        isPilotExempt: true,
        trialStartedAt: null,
        trialEndsAt: null,
        currentPeriodEndsAt: null,
      },
      { enforceSubscriptions: config.enforceSubscriptions }
    );
  }

  return evaluateEntitlementPolicy(rows[0], {
    enforceSubscriptions: config.enforceSubscriptions,
  });
}
