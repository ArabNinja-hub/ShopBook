import crypto from 'node:crypto';
import { AppDatabase, AppTransaction } from '../db/client';
import { auditLogs } from '../db/schema';

export interface AuditEventInput {
  shopId?: string | null;
  actorUserId?: string | null;
  eventType: string;
  entityType?: string | null;
  entityId?: string | null;
  ipAddress?: string | null;
  details?: Record<string, unknown>;
}

export async function recordAuditEvent(
  dbOrTx: AppDatabase | AppTransaction,
  input: AuditEventInput
): Promise<void> {
  await dbOrTx.insert(auditLogs).values({
    id: crypto.randomUUID(),
    shopId: input.shopId ?? null,
    actorUserId: input.actorUserId ?? null,
    eventType: input.eventType,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    ipAddress: input.ipAddress ?? null,
    detailsJson: input.details ?? {},
  });
}
