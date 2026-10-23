import crypto from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { nextDailyReceiptNumber } from '../../src/domain/ids';
import {
  CreditTransaction,
  Customer,
  Product,
  Sale,
  SaleItem,
  StockMovement,
} from '../../src/domain/types';
import {
  StockConflictNotice,
  SyncEntityType,
  SyncLedgerEntryView,
  SyncOperationEnvelope,
  SyncOperationPayloadMap,
  SyncPullResponse,
  SyncPushOperationResult,
  SyncPushResponse,
} from '../../src/shared/syncTypes';
import { ServerConfig } from '../config';
import { AppTransaction, DatabaseContext } from '../db/client';
import {
  appliedOperations,
  creditTransactions,
  customers,
  products,
  saleItems,
  sales,
  shops,
  stockConflicts,
  stockMovements,
  syncLedger,
} from '../db/schema';
import { BadRequestError, NotFoundApiError } from './syncErrors';
import { recordAuditEvent } from './auditService';
import { getShopEntitlementView } from './entitlementService';

async function appendLedgerEntry(
  tx: AppTransaction,
  input: {
    shopId: string;
    entityType: SyncEntityType;
    entityId: string;
    action: 'upsert' | 'delete';
    record: unknown;
    sourceOperationId: string;
    now: Date;
  }
): Promise<number> {
  const inserted = await tx
    .insert(syncLedger)
    .values({
      shopId: input.shopId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      recordJson: input.record as Record<string, unknown>,
      sourceOperationId: input.sourceOperationId,
      createdAt: input.now,
    })
    .returning({ seq: syncLedger.seq });

  return inserted[0]?.seq ?? 0;
}

function dbProductToDomain(row: typeof products.$inferSelect): Product {
  return {
    id: row.id,
    name: row.name,
    unitLabel: row.unitLabel,
    sellingPriceNgwee: row.sellingPriceNgwee,
    costPriceNgwee: row.costPriceNgwee,
    stockQty: row.stockQty,
    lowStockThreshold: row.lowStockThreshold,
    isArchived: row.isArchived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function dbCustomerToDomain(row: typeof customers.$inferSelect): Customer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function dbMovementToDomain(
  row: typeof stockMovements.$inferSelect
): StockMovement {
  return {
    id: row.id,
    operationId: row.operationId,
    productId: row.productId,
    productNameSnapshot: row.productNameSnapshot,
    type: row.type,
    deltaQty: row.deltaQty,
    previousQty: row.previousQty,
    newQty: row.newQty,
    reason: row.conflictNote ? `${row.reason} (${row.conflictNote})` : row.reason,
    relatedSaleId: row.relatedSaleId,
    createdAt: row.createdAt.toISOString(),
  };
}

function dbConflictToView(
  row: typeof stockConflicts.$inferSelect
): StockConflictNotice {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.productName,
    operationId: row.operationId,
    relatedSaleId: row.relatedSaleId,
    serverQtyBefore: row.serverQtyBefore,
    requestedDeductionQty: row.requestedDeductionQty,
    shortfallQty: row.shortfallQty,
    clampedQtyAfter: row.clampedQtyAfter,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

async function listOpenConflictsForShop(
  dbCtx: DatabaseContext,
  shopId: string
): Promise<StockConflictNotice[]> {
  const rows = await dbCtx.db
    .select()
    .from(stockConflicts)
    .where(
      and(eq(stockConflicts.shopId, shopId), eq(stockConflicts.status, 'open'))
    )
    .orderBy(asc(stockConflicts.createdAt));

  return rows.map(dbConflictToView);
}

/**
 * Applies an ordered batch of client outbox operations idempotently for a single authenticated shop.
 *
 * Guarantees:
 * - Strict per-shop row lock (`SELECT id FROM shops WHERE id = $1 FOR UPDATE`) prevents concurrent
 *   multi-device race conditions on receipt numbers, stock quantities, and idempotency keys,
 *   without blocking any other shop on the server.
 * - Duplicate retries (`(shop_id, operation_id)` already in `applied_operations`) return `duplicate_noop`
 *   with zero side effects.
 * - Completed offline sales and debt repayments are NEVER discarded when stock or balances changed on
 *   another device while offline: oversold stock is clamped at `0` and flagged in `stock_conflicts`.
 */
export async function pushSyncOperations(
  dbCtx: DatabaseContext,
  _config: ServerConfig,
  input: {
    shopId: string;
    actorUserId: string;
    ipAddress?: string | null;
    operations: SyncOperationEnvelope[];
  }
): Promise<SyncPushResponse> {
  const { shopId, actorUserId, ipAddress } = input;
  const results: SyncPushOperationResult[] = [];
  let latestCursor = 0;

  for (const op of input.operations) {
    const opResult = await dbCtx.runInTransaction(async (tx) => {
      // 1. Serialize concurrent mutations for THIS shop only via parameterized row lock
      await tx.execute(
        sql`SELECT id FROM shops WHERE id = ${shopId} FOR UPDATE`
      );

      // 2. Check idempotency ledger (`applied_operations`)
      const alreadyApplied = await tx
        .select()
        .from(appliedOperations)
        .where(
          and(
            eq(appliedOperations.shopId, shopId),
            eq(appliedOperations.operationId, op.operationId)
          )
        )
        .limit(1);

      if (alreadyApplied.length > 0) {
        const prevSummary = (alreadyApplied[0].resultSummaryJson ?? {}) as {
          reassignedReceiptNumber?: string;
          stockConflict?: StockConflictNotice;
        };
        return {
          operationId: op.operationId,
          status: 'duplicate_noop' as const,
          syncSeq: alreadyApplied[0].resultSyncSeq,
          reassignedReceiptNumber: prevSummary.reassignedReceiptNumber,
          stockConflict: prevSummary.stockConflict,
        };
      }

      const now = new Date();
      let lastSeq = 0;
      let reassignedReceiptNumber: string | undefined;
      let firstStockConflict: StockConflictNotice | undefined;

      switch (op.opType) {
        case 'shop.update_name': {
          const payload =
            op.payload as SyncOperationPayloadMap['shop.update_name'];
          const shopName = payload.shopName.trim().replace(/\s+/g, ' ').slice(0, 80);
          if (!shopName) {
            throw new BadRequestError('Shop name cannot be empty.');
          }
          const incomingUpdatedAt = new Date(payload.updatedAt);
          const [currentShop] = await tx
            .select()
            .from(shops)
            .where(eq(shops.id, shopId))
            .limit(1);

          const effectiveName =
            currentShop && incomingUpdatedAt < currentShop.updatedAt
              ? currentShop.name
              : shopName;
          const effectiveUpdated =
            currentShop && incomingUpdatedAt < currentShop.updatedAt
              ? currentShop.updatedAt
              : incomingUpdatedAt;

          await tx
            .update(shops)
            .set({ name: effectiveName, updatedAt: effectiveUpdated })
            .where(eq(shops.id, shopId));

          lastSeq = await appendLedgerEntry(tx, {
            shopId,
            entityType: 'shop_settings',
            entityId: 'shopSettings',
            action: 'upsert',
            record: {
              shopName: effectiveName,
              updatedAt: effectiveUpdated.toISOString(),
            },
            sourceOperationId: op.operationId,
            now,
          });
          break;
        }

        case 'product.create': {
          const payload =
            op.payload as SyncOperationPayloadMap['product.create'];
          const p = payload.product;
          const m = payload.initialMovement;
          if (p.isDemo || m.isDemo) {
            throw new BadRequestError(
              'Sample [DEMO] records cannot be synced to the server.'
            );
          }

          const existing = await tx
            .select()
            .from(products)
            .where(and(eq(products.shopId, shopId), eq(products.id, p.id)))
            .limit(1);

          let savedRow: typeof products.$inferSelect;
          if (existing.length === 0) {
            const [inserted] = await tx
              .insert(products)
              .values({
                shopId,
                id: p.id,
                name: p.name.trim().slice(0, 120),
                unitLabel: (p.unitLabel ?? '').trim().slice(0, 40),
                sellingPriceNgwee: p.sellingPriceNgwee,
                costPriceNgwee: p.costPriceNgwee,
                stockQty: Math.max(0, m.newQty),
                lowStockThreshold: p.lowStockThreshold,
                isArchived: Boolean(p.isArchived),
                needsStockRecount: false,
                createdAt: new Date(p.createdAt),
                updatedAt: new Date(p.updatedAt),
              })
              .returning();
            savedRow = inserted;

            const existingMove = await tx
              .select({ id: stockMovements.id })
              .from(stockMovements)
              .where(
                and(
                  eq(stockMovements.shopId, shopId),
                  eq(stockMovements.operationId, m.operationId)
                )
              )
              .limit(1);

            if (existingMove.length === 0) {
              const [insertedMove] = await tx
                .insert(stockMovements)
                .values({
                  shopId,
                  id: m.id,
                  operationId: m.operationId,
                  productId: p.id,
                  productNameSnapshot: p.name,
                  type: 'initial',
                  deltaQty: m.deltaQty,
                  previousQty: Math.max(0, m.previousQty),
                  newQty: Math.max(0, m.newQty),
                  reason: m.reason || 'Opening stock',
                  relatedSaleId: null,
                  conflictNote: null,
                  recordedByUserId: actorUserId,
                  createdAt: new Date(m.createdAt),
                })
                .returning();

              await appendLedgerEntry(tx, {
                shopId,
                entityType: 'stock_movement',
                entityId: insertedMove.id,
                action: 'upsert',
                record: dbMovementToDomain(insertedMove),
                sourceOperationId: op.operationId,
                now,
              });
            }
          } else {
            savedRow = existing[0];
          }

          lastSeq = await appendLedgerEntry(tx, {
            shopId,
            entityType: 'product',
            entityId: savedRow.id,
            action: 'upsert',
            record: dbProductToDomain(savedRow),
            sourceOperationId: op.operationId,
            now,
          });
          break;
        }

        case 'product.update': {
          const payload =
            op.payload as SyncOperationPayloadMap['product.update'];
          const [existing] = await tx
            .select()
            .from(products)
            .where(
              and(eq(products.shopId, shopId), eq(products.id, payload.productId))
            )
            .limit(1);

          if (!existing) {
            throw new NotFoundApiError(
              `Product "${payload.productId}" not found in shop.`
            );
          }

          const incomingUpdated = new Date(payload.updatedAt);
          let savedRow = existing;
          if (incomingUpdated >= existing.updatedAt) {
            const [updated] = await tx
              .update(products)
              .set({
                name: payload.name.trim().slice(0, 120),
                unitLabel: (payload.unitLabel ?? '').trim().slice(0, 40),
                sellingPriceNgwee: payload.sellingPriceNgwee,
                costPriceNgwee: payload.costPriceNgwee,
                lowStockThreshold: payload.lowStockThreshold,
                updatedAt: incomingUpdated,
              })
              .where(
                and(
                  eq(products.shopId, shopId),
                  eq(products.id, payload.productId)
                )
              )
              .returning();
            savedRow = updated;
          }

          lastSeq = await appendLedgerEntry(tx, {
            shopId,
            entityType: 'product',
            entityId: savedRow.id,
            action: 'upsert',
            record: dbProductToDomain(savedRow),
            sourceOperationId: op.operationId,
            now,
          });
          break;
        }

        case 'product.archive': {
          const payload =
            op.payload as SyncOperationPayloadMap['product.archive'];
          const [existing] = await tx
            .select()
            .from(products)
            .where(
              and(eq(products.shopId, shopId), eq(products.id, payload.productId))
            )
            .limit(1);

          if (!existing) {
            throw new NotFoundApiError(
              `Product "${payload.productId}" not found in shop.`
            );
          }

          const [updated] = await tx
            .update(products)
            .set({
              isArchived: payload.isArchived,
              updatedAt: new Date(payload.updatedAt),
            })
            .where(
              and(eq(products.shopId, shopId), eq(products.id, payload.productId))
            )
            .returning();

          lastSeq = await appendLedgerEntry(tx, {
            shopId,
            entityType: 'product',
            entityId: updated.id,
            action: 'upsert',
            record: dbProductToDomain(updated),
            sourceOperationId: op.operationId,
            now,
          });
          break;
        }

        case 'stock.adjust': {
          const payload =
            op.payload as SyncOperationPayloadMap['stock.adjust'];
          const [productRow] = await tx
            .select()
            .from(products)
            .where(
              and(eq(products.shopId, shopId), eq(products.id, payload.productId))
            )
            .limit(1);

          if (!productRow) {
            throw new NotFoundApiError(
              `Product "${payload.productId}" not found in shop.`
            );
          }

          const serverBefore = productRow.stockQty;
          let newQty = serverBefore;
          let deltaQty = 0;
          let conflictNote: string | null = null;
          let needsRecount = productRow.needsStockRecount;

          if (payload.mode === 'add') {
            newQty = serverBefore + payload.quantity;
            deltaQty = payload.quantity;
          } else if (payload.mode === 'subtract') {
            if (serverBefore >= payload.quantity) {
              newQty = serverBefore - payload.quantity;
              deltaQty = -payload.quantity;
            } else {
              const shortfall = payload.quantity - serverBefore;
              newQty = 0;
              deltaQty = -payload.quantity;
              needsRecount = true;
              conflictNote = `Offline stock conflict: tried to remove ${payload.quantity} while server had ${serverBefore}; clamped at 0 (shortfall ${shortfall}).`;

              const [conflictRow] = await tx
                .insert(stockConflicts)
                .values({
                  id: crypto.randomUUID(),
                  shopId,
                  productId: productRow.id,
                  productName: productRow.name,
                  operationId: op.operationId,
                  relatedSaleId: null,
                  serverQtyBefore: serverBefore,
                  requestedDeductionQty: payload.quantity,
                  shortfallQty: shortfall,
                  clampedQtyAfter: 0,
                  status: 'open',
                  createdAt: now,
                })
                .returning();

              firstStockConflict = dbConflictToView(conflictRow);
              await appendLedgerEntry(tx, {
                shopId,
                entityType: 'stock_conflict',
                entityId: conflictRow.id,
                action: 'upsert',
                record: firstStockConflict,
                sourceOperationId: op.operationId,
                now,
              });
            }
          } else if (payload.mode === 'set') {
            newQty = payload.quantity;
            deltaQty = newQty - serverBefore;
            needsRecount = false;

            // Physical count resolves any open stock conflicts for this product
            const resolvedRows = await tx
              .update(stockConflicts)
              .set({
                status: 'resolved',
                resolvedAt: now,
                resolvedByOperationId: op.operationId,
              })
              .where(
                and(
                  eq(stockConflicts.shopId, shopId),
                  eq(stockConflicts.productId, productRow.id),
                  eq(stockConflicts.status, 'open')
                )
              )
              .returning();

            for (const r of resolvedRows) {
              await appendLedgerEntry(tx, {
                shopId,
                entityType: 'stock_conflict',
                entityId: r.id,
                action: 'upsert',
                record: dbConflictToView(r),
                sourceOperationId: op.operationId,
                now,
              });
            }
          }

          const [updatedProduct] = await tx
            .update(products)
            .set({
              stockQty: newQty,
              needsStockRecount: needsRecount,
              updatedAt: new Date(payload.updatedAt),
            })
            .where(
              and(eq(products.shopId, shopId), eq(products.id, productRow.id))
            )
            .returning();

          const moveOpId = payload.movement.operationId || op.operationId;
          const [insertedMove] = await tx
            .insert(stockMovements)
            .values({
              shopId,
              id: payload.movement.id,
              operationId: moveOpId,
              productId: productRow.id,
              productNameSnapshot: productRow.name,
              type: payload.movement.type,
              deltaQty,
              previousQty: serverBefore,
              newQty,
              reason: payload.movement.reason || 'Stock adjustment',
              relatedSaleId: null,
              conflictNote,
              recordedByUserId: actorUserId,
              createdAt: new Date(payload.movement.createdAt),
            })
            .returning();

          await appendLedgerEntry(tx, {
            shopId,
            entityType: 'stock_movement',
            entityId: insertedMove.id,
            action: 'upsert',
            record: dbMovementToDomain(insertedMove),
            sourceOperationId: op.operationId,
            now,
          });

          lastSeq = await appendLedgerEntry(tx, {
            shopId,
            entityType: 'product',
            entityId: updatedProduct.id,
            action: 'upsert',
            record: dbProductToDomain(updatedProduct),
            sourceOperationId: op.operationId,
            now,
          });

          await recordAuditEvent(tx, {
            shopId,
            actorUserId,
            eventType: 'stock.adjusted',
            entityType: 'product',
            entityId: updatedProduct.id,
            ipAddress: ipAddress ?? null,
            details: {
              mode: payload.mode,
              serverBefore,
              newQty,
              conflictClamped: Boolean(conflictNote),
            },
          });
          break;
        }

        case 'customer.create': {
          const payload =
            op.payload as SyncOperationPayloadMap['customer.create'];
          const c = payload.customer;
          if (c.isDemo) {
            throw new BadRequestError(
              'Sample [DEMO] records cannot be synced to the server.'
            );
          }

          const existing = await tx
            .select()
            .from(customers)
            .where(and(eq(customers.shopId, shopId), eq(customers.id, c.id)))
            .limit(1);

          let savedRow: typeof customers.$inferSelect;
          if (existing.length === 0) {
            const [inserted] = await tx
              .insert(customers)
              .values({
                shopId,
                id: c.id,
                name: c.name.trim().slice(0, 100),
                phone: (c.phone ?? '').trim().slice(0, 30),
                notes: (c.notes ?? '').trim().slice(0, 200),
                createdAt: new Date(c.createdAt),
                updatedAt: new Date(c.updatedAt),
              })
              .returning();
            savedRow = inserted;
          } else {
            savedRow = existing[0];
          }

          lastSeq = await appendLedgerEntry(tx, {
            shopId,
            entityType: 'customer',
            entityId: savedRow.id,
            action: 'upsert',
            record: dbCustomerToDomain(savedRow),
            sourceOperationId: op.operationId,
            now,
          });
          break;
        }

        case 'customer.update': {
          const payload =
            op.payload as SyncOperationPayloadMap['customer.update'];
          const [existing] = await tx
            .select()
            .from(customers)
            .where(
              and(
                eq(customers.shopId, shopId),
                eq(customers.id, payload.customerId)
              )
            )
            .limit(1);

          if (!existing) {
            throw new NotFoundApiError(
              `Customer "${payload.customerId}" not found in shop.`
            );
          }

          const incomingUpdated = new Date(payload.updatedAt);
          let savedRow = existing;
          if (incomingUpdated >= existing.updatedAt) {
            const [updated] = await tx
              .update(customers)
              .set({
                name: payload.name.trim().slice(0, 100),
                phone: (payload.phone ?? '').trim().slice(0, 30),
                notes: (payload.notes ?? '').trim().slice(0, 200),
                updatedAt: incomingUpdated,
              })
              .where(
                and(
                  eq(customers.shopId, shopId),
                  eq(customers.id, payload.customerId)
                )
              )
              .returning();
            savedRow = updated;
          }

          lastSeq = await appendLedgerEntry(tx, {
            shopId,
            entityType: 'customer',
            entityId: savedRow.id,
            action: 'upsert',
            record: dbCustomerToDomain(savedRow),
            sourceOperationId: op.operationId,
            now,
          });
          break;
        }

        case 'sale.record': {
          const payload = op.payload as SyncOperationPayloadMap['sale.record'];
          const incomingSale = payload.sale;
          if (incomingSale.isDemo) {
            throw new BadRequestError(
              'Sample [DEMO] sales cannot be synced to the server.'
            );
          }

          // 1. Ensure customer exists if credit sale (never drop a completed credit sale!)
          if (incomingSale.customerId) {
            const existingCust = await tx
              .select({ id: customers.id })
              .from(customers)
              .where(
                and(
                  eq(customers.shopId, shopId),
                  eq(customers.id, incomingSale.customerId)
                )
              )
              .limit(1);

            if (existingCust.length === 0) {
              const [recoveredCust] = await tx
                .insert(customers)
                .values({
                  shopId,
                  id: incomingSale.customerId,
                  name:
                    (incomingSale.customerNameSnapshot ?? '').trim() ||
                    'Recovered Customer',
                  phone: '',
                  notes: 'Auto-created from offline credit sale sync',
                  createdAt: new Date(incomingSale.createdAt),
                  updatedAt: new Date(incomingSale.createdAt),
                })
                .returning();

              await appendLedgerEntry(tx, {
                shopId,
                entityType: 'customer',
                entityId: recoveredCust.id,
                action: 'upsert',
                record: dbCustomerToDomain(recoveredCust),
                sourceOperationId: op.operationId,
                now,
              });
            }
          }

          // 2. Resolve receipt number collisions safely across offline devices
          let finalReceiptNumber = incomingSale.receiptNumber;
          const collidingReceipt = await tx
            .select({ id: sales.id })
            .from(sales)
            .where(
              and(
                eq(sales.shopId, shopId),
                eq(sales.receiptNumber, incomingSale.receiptNumber)
              )
            )
            .limit(1);

          if (
            collidingReceipt.length > 0 &&
            collidingReceipt[0].id !== incomingSale.id
          ) {
            const daySales = await tx
              .select({ receiptNumber: sales.receiptNumber })
              .from(sales)
              .where(
                and(
                  eq(sales.shopId, shopId),
                  eq(sales.localDate, incomingSale.localDate)
                )
              );
            finalReceiptNumber = nextDailyReceiptNumber(
              incomingSale.localDate,
              daySales.map((s) => s.receiptNumber)
            );
            reassignedReceiptNumber = finalReceiptNumber;

            await recordAuditEvent(tx, {
              shopId,
              actorUserId,
              eventType: 'sale.receipt_reassigned',
              entityType: 'sale',
              entityId: incomingSale.id,
              details: {
                clientReceiptNumber: incomingSale.receiptNumber,
                assignedReceiptNumber: finalReceiptNumber,
              },
            });
          }

          // 3. Deduct stock per item WITHOUT ever discarding a completed offline sale
          const qtyByProduct = new Map<
            string,
            { qty: number; sampleItem: SaleItem }
          >();
          for (const item of payload.saleItems) {
            const cur = qtyByProduct.get(item.productId);
            if (cur) {
              cur.qty += item.quantity;
            } else {
              qtyByProduct.set(item.productId, {
                qty: item.quantity,
                sampleItem: item,
              });
            }
          }

          const movementByProduct = new Map<string, StockMovement>();
          for (const mv of payload.stockMovements) {
            movementByProduct.set(mv.productId, mv);
          }

          for (const [productId, { qty, sampleItem }] of qtyByProduct.entries()) {
            let [productRow] = await tx
              .select()
              .from(products)
              .where(
                and(eq(products.shopId, shopId), eq(products.id, productId))
              )
              .limit(1);

            if (!productRow) {
              // Recover product from sale snapshot if created out of order so sale is never lost
              const [recoveredProd] = await tx
                .insert(products)
                .values({
                  shopId,
                  id: productId,
                  name: sampleItem.productNameAtSale,
                  unitLabel: sampleItem.unitLabelAtSale,
                  sellingPriceNgwee: sampleItem.sellingPriceAtSaleNgwee,
                  costPriceNgwee: sampleItem.costPriceAtSaleNgwee,
                  stockQty: 0,
                  lowStockThreshold: 5,
                  isArchived: false,
                  needsStockRecount: true,
                  createdAt: new Date(incomingSale.createdAt),
                  updatedAt: new Date(incomingSale.createdAt),
                })
                .returning();
              productRow = recoveredProd;
            }

            const serverBefore = productRow.stockQty;
            let newQty = serverBefore - qty;
            let conflictNote: string | null = null;
            let needsRecount = productRow.needsStockRecount;

            if (newQty < 0) {
              const shortfall = qty - serverBefore;
              newQty = 0;
              needsRecount = true;
              conflictNote = `Offline oversell conflict: sold ${qty} while server stock had ${serverBefore} (shortfall ${shortfall}); stock clamped at 0 for physical recount.`;

              const [conflictRow] = await tx
                .insert(stockConflicts)
                .values({
                  id: crypto.randomUUID(),
                  shopId,
                  productId: productRow.id,
                  productName: productRow.name,
                  operationId: op.operationId,
                  relatedSaleId: incomingSale.id,
                  serverQtyBefore: serverBefore,
                  requestedDeductionQty: qty,
                  shortfallQty: shortfall,
                  clampedQtyAfter: 0,
                  status: 'open',
                  createdAt: now,
                })
                .returning();

              const conflictView = dbConflictToView(conflictRow);
              if (!firstStockConflict) {
                firstStockConflict = conflictView;
              }

              await appendLedgerEntry(tx, {
                shopId,
                entityType: 'stock_conflict',
                entityId: conflictRow.id,
                action: 'upsert',
                record: conflictView,
                sourceOperationId: op.operationId,
                now,
              });

              await recordAuditEvent(tx, {
                shopId,
                actorUserId,
                eventType: 'sale.stock_conflict_clamped',
                entityType: 'product',
                entityId: productRow.id,
                ipAddress: ipAddress ?? null,
                details: {
                  saleId: incomingSale.id,
                  receiptNumber: finalReceiptNumber,
                  serverBefore,
                  soldQty: qty,
                  shortfall,
                },
              });
            }

            const [updatedProduct] = await tx
              .update(products)
              .set({
                stockQty: newQty,
                needsStockRecount: needsRecount,
                updatedAt: new Date(incomingSale.createdAt),
              })
              .where(
                and(eq(products.shopId, shopId), eq(products.id, productRow.id))
              )
              .returning();

            const clientMove = movementByProduct.get(productId);
            const moveId = clientMove?.id ?? `stk_${crypto.randomUUID()}`;
            const moveOpId =
              clientMove?.operationId ?? `${op.operationId}_stk_${productId}`;

            const [insertedMove] = await tx
              .insert(stockMovements)
              .values({
                shopId,
                id: moveId,
                operationId: moveOpId,
                productId: productRow.id,
                productNameSnapshot: sampleItem.productNameAtSale,
                type: 'sale',
                deltaQty: -qty,
                previousQty: serverBefore,
                newQty,
                reason: `Sale ${finalReceiptNumber}`,
                relatedSaleId: incomingSale.id,
                conflictNote,
                recordedByUserId: actorUserId,
                createdAt: new Date(incomingSale.createdAt),
              })
              .returning();

            await appendLedgerEntry(tx, {
              shopId,
              entityType: 'stock_movement',
              entityId: insertedMove.id,
              action: 'upsert',
              record: dbMovementToDomain(insertedMove),
              sourceOperationId: op.operationId,
              now,
            });

            await appendLedgerEntry(tx, {
              shopId,
              entityType: 'product',
              entityId: updatedProduct.id,
              action: 'upsert',
              record: dbProductToDomain(updatedProduct),
              sourceOperationId: op.operationId,
              now,
            });
          }

          // 4. Insert Sale & SaleItems snapshots
          const canonicalSale: Sale = {
            ...incomingSale,
            receiptNumber: finalReceiptNumber,
          };

          await tx.insert(sales).values({
            shopId,
            id: canonicalSale.id,
            operationId: canonicalSale.operationId,
            receiptNumber: canonicalSale.receiptNumber,
            paymentMethod: canonicalSale.paymentMethod,
            paymentReference: canonicalSale.paymentReference,
            customerId: canonicalSale.customerId,
            customerNameSnapshot: canonicalSale.customerNameSnapshot,
            totalNgwee: canonicalSale.totalNgwee,
            totalUnits: canonicalSale.totalUnits,
            knownCostTotalNgwee: canonicalSale.knownCostTotalNgwee,
            knownCostRevenueNgwee: canonicalSale.knownCostRevenueNgwee,
            missingCostLineCount: canonicalSale.missingCostLineCount,
            missingCostRevenueNgwee: canonicalSale.missingCostRevenueNgwee,
            note: canonicalSale.note ?? '',
            localDate: canonicalSale.localDate,
            recordedByUserId: actorUserId,
            createdAt: new Date(canonicalSale.createdAt),
          });

          for (const item of payload.saleItems) {
            await tx.insert(saleItems).values({
              shopId,
              id: item.id,
              saleId: canonicalSale.id,
              productId: item.productId,
              productNameAtSale: item.productNameAtSale,
              unitLabelAtSale: item.unitLabelAtSale ?? '',
              sellingPriceAtSaleNgwee: item.sellingPriceAtSaleNgwee,
              costPriceAtSaleNgwee: item.costPriceAtSaleNgwee,
              quantity: item.quantity,
              lineTotalNgwee: item.lineTotalNgwee,
              createdAt: new Date(item.createdAt),
            });
          }

          lastSeq = await appendLedgerEntry(tx, {
            shopId,
            entityType: 'sale',
            entityId: canonicalSale.id,
            action: 'upsert',
            record: {
              sale: canonicalSale,
              saleItems: payload.saleItems,
            },
            sourceOperationId: op.operationId,
            now,
          });

          // 5. Insert credit charge if credit sale
          if (
            canonicalSale.paymentMethod === 'credit' &&
            payload.creditTransaction
          ) {
            const ctxRow = payload.creditTransaction;
            const updatedCreditNote = reassignedReceiptNumber
              ? ctxRow.note.replace(
                  incomingSale.receiptNumber,
                  finalReceiptNumber
                )
              : ctxRow.note;

            const canonicalCredit: CreditTransaction = {
              ...ctxRow,
              note: updatedCreditNote,
            };

            await tx.insert(creditTransactions).values({
              shopId,
              id: canonicalCredit.id,
              operationId: canonicalCredit.operationId,
              customerId: canonicalCredit.customerId,
              customerNameSnapshot: canonicalCredit.customerNameSnapshot,
              type: 'credit_sale',
              amountNgwee: canonicalCredit.amountNgwee,
              paymentMethod: null,
              relatedSaleId: canonicalSale.id,
              note: canonicalCredit.note,
              localDate: canonicalCredit.localDate,
              recordedByUserId: actorUserId,
              createdAt: new Date(canonicalCredit.createdAt),
            });

            lastSeq = await appendLedgerEntry(tx, {
              shopId,
              entityType: 'credit_transaction',
              entityId: canonicalCredit.id,
              action: 'upsert',
              record: canonicalCredit,
              sourceOperationId: op.operationId,
              now,
            });
          }

          await recordAuditEvent(tx, {
            shopId,
            actorUserId,
            eventType: 'sale.recorded',
            entityType: 'sale',
            entityId: canonicalSale.id,
            ipAddress: ipAddress ?? null,
            details: {
              receiptNumber: canonicalSale.receiptNumber,
              paymentMethod: canonicalSale.paymentMethod,
              totalNgwee: canonicalSale.totalNgwee,
            },
          });
          break;
        }

        case 'credit.repayment': {
          const payload =
            op.payload as SyncOperationPayloadMap['credit.repayment'];
          const repay = payload.repayment;
          if (repay.isDemo) {
            throw new BadRequestError(
              'Sample [DEMO] repayments cannot be synced to the server.'
            );
          }

          // Ensure customer exists so completed offline repayments are NEVER discarded
          let [custRow] = await tx
            .select()
            .from(customers)
            .where(
              and(
                eq(customers.shopId, shopId),
                eq(customers.id, repay.customerId)
              )
            )
            .limit(1);

          if (!custRow) {
            const [recovered] = await tx
              .insert(customers)
              .values({
                shopId,
                id: repay.customerId,
                name:
                  repay.customerNameSnapshot.trim() || 'Recovered Customer',
                phone: '',
                notes: 'Auto-created from offline repayment sync',
                createdAt: new Date(repay.createdAt),
                updatedAt: new Date(repay.createdAt),
              })
              .returning();
            custRow = recovered;

            await appendLedgerEntry(tx, {
              shopId,
              entityType: 'customer',
              entityId: custRow.id,
              action: 'upsert',
              record: dbCustomerToDomain(custRow),
              sourceOperationId: op.operationId,
              now,
            });
          }

          const priorTxs = await tx
            .select()
            .from(creditTransactions)
            .where(
              and(
                eq(creditTransactions.shopId, shopId),
                eq(creditTransactions.customerId, repay.customerId)
              )
            );

          let netBefore = 0;
          for (const t of priorTxs) {
            netBefore +=
              t.type === 'credit_sale' ? t.amountNgwee : -t.amountNgwee;
          }

          if (repay.amountNgwee > netBefore) {
            await recordAuditEvent(tx, {
              shopId,
              actorUserId,
              eventType: 'credit.overpayment_or_out_of_order_flagged',
              entityType: 'customer',
              entityId: repay.customerId,
              ipAddress: ipAddress ?? null,
              details: {
                repaymentId: repay.id,
                amountNgwee: repay.amountNgwee,
                netBeforeNgwee: netBefore,
              },
            });
          }

          await tx.insert(creditTransactions).values({
            shopId,
            id: repay.id,
            operationId: repay.operationId,
            customerId: repay.customerId,
            customerNameSnapshot: repay.customerNameSnapshot,
            type: 'repayment',
            amountNgwee: repay.amountNgwee,
            paymentMethod: repay.paymentMethod,
            relatedSaleId: null,
            note: repay.note ?? '',
            localDate: repay.localDate,
            recordedByUserId: actorUserId,
            createdAt: new Date(repay.createdAt),
          });

          await tx
            .update(customers)
            .set({ updatedAt: new Date(payload.customerUpdatedAt) })
            .where(
              and(
                eq(customers.shopId, shopId),
                eq(customers.id, repay.customerId)
              )
            );

          lastSeq = await appendLedgerEntry(tx, {
            shopId,
            entityType: 'credit_transaction',
            entityId: repay.id,
            action: 'upsert',
            record: repay,
            sourceOperationId: op.operationId,
            now,
          });

          await recordAuditEvent(tx, {
            shopId,
            actorUserId,
            eventType: 'credit.repayment_recorded',
            entityType: 'credit_transaction',
            entityId: repay.id,
            ipAddress: ipAddress ?? null,
            details: {
              customerId: repay.customerId,
              amountNgwee: repay.amountNgwee,
              paymentMethod: repay.paymentMethod,
            },
          });
          break;
        }
      }

      const summary = {
        ...(reassignedReceiptNumber ? { reassignedReceiptNumber } : {}),
        ...(firstStockConflict ? { stockConflict: firstStockConflict } : {}),
      };

      await tx.insert(appliedOperations).values({
        shopId,
        operationId: op.operationId,
        opType: op.opType,
        actorUserId,
        resultSyncSeq: lastSeq,
        resultSummaryJson: summary,
        appliedAt: now,
      });

      return {
        operationId: op.operationId,
        status: 'applied' as const,
        syncSeq: lastSeq,
        reassignedReceiptNumber,
        stockConflict: firstStockConflict,
      };
    });

    if (opResult.syncSeq > latestCursor) {
      latestCursor = opResult.syncSeq;
    }
    results.push(opResult);
  }

  const openConflicts = await listOpenConflictsForShop(dbCtx, shopId);

  return {
    results,
    latestCursor,
    openStockConflicts: openConflicts,
    serverTime: new Date().toISOString(),
  };
}

/**
 * Cursor-based pull of canonical shop changes strictly isolated to `shopId`.
 */
export async function pullSyncLedger(
  dbCtx: DatabaseContext,
  config: ServerConfig,
  input: {
    shopId: string;
    afterCursor: number;
    limit: number;
  }
): Promise<SyncPullResponse> {
  const safeLimit = Math.min(Math.max(1, input.limit), 500);

  const ledgerRows = await dbCtx.db
    .select()
    .from(syncLedger)
    .where(
      and(
        eq(syncLedger.shopId, input.shopId),
        gt(syncLedger.seq, input.afterCursor)
      )
    )
    .orderBy(asc(syncLedger.seq))
    .limit(safeLimit + 1);

  const hasMore = ledgerRows.length > safeLimit;
  const pageRows = hasMore ? ledgerRows.slice(0, safeLimit) : ledgerRows;

  const entries: SyncLedgerEntryView[] = pageRows.map((row) => ({
    seq: row.seq,
    entityType: row.entityType as SyncEntityType,
    entityId: row.entityId,
    action: row.action,
    record: row.recordJson,
    sourceOperationId: row.sourceOperationId,
    createdAt: row.createdAt.toISOString(),
  }));

  const nextCursor =
    entries.length > 0
      ? entries[entries.length - 1].seq
      : input.afterCursor;

  const [shopRow] = await dbCtx.db
    .select({ name: shops.name })
    .from(shops)
    .where(eq(shops.id, input.shopId))
    .limit(1);

  const [entitlement, openConflicts] = await Promise.all([
    getShopEntitlementView(dbCtx.db, input.shopId, config),
    listOpenConflictsForShop(dbCtx, input.shopId),
  ]);

  return {
    entries,
    nextCursor,
    hasMore,
    entitlement,
    openStockConflicts: openConflicts,
    shopName: shopRow?.name ?? 'My Shop',
    serverTime: new Date().toISOString(),
  };
}

/**
 * Allows an authenticated shop member to acknowledge/resolve a stock conflict banner
 * once physical shelves have been verified.
 */
export async function resolveStockConflict(
  dbCtx: DatabaseContext,
  input: {
    shopId: string;
    actorUserId: string;
    conflictId: string;
  }
): Promise<StockConflictNotice> {
  return dbCtx.runInTransaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(stockConflicts)
      .where(
        and(
          eq(stockConflicts.shopId, input.shopId),
          eq(stockConflicts.id, input.conflictId)
        )
      )
      .limit(1);

    if (!existing) {
      throw new NotFoundApiError('Stock conflict notice not found.');
    }

    const now = new Date();
    const [updated] = await tx
      .update(stockConflicts)
      .set({
        status: 'resolved',
        resolvedAt: now,
        resolvedByOperationId: `manual_resolve_${input.conflictId}`,
      })
      .where(
        and(
          eq(stockConflicts.shopId, input.shopId),
          eq(stockConflicts.id, input.conflictId)
        )
      )
      .returning();

    // Check if any other open conflicts remain on this product
    const remainingOpen = await tx
      .select({ id: stockConflicts.id })
      .from(stockConflicts)
      .where(
        and(
          eq(stockConflicts.shopId, input.shopId),
          eq(stockConflicts.productId, existing.productId),
          eq(stockConflicts.status, 'open')
        )
      )
      .limit(1);

    if (remainingOpen.length === 0) {
      await tx
        .update(products)
        .set({ needsStockRecount: false, updatedAt: now })
        .where(
          and(
            eq(products.shopId, input.shopId),
            eq(products.id, existing.productId)
          )
        );
    }

    const view = dbConflictToView(updated);
    await appendLedgerEntry(tx, {
      shopId: input.shopId,
      entityType: 'stock_conflict',
      entityId: updated.id,
      action: 'upsert',
      record: view,
      sourceOperationId: `manual_resolve_${input.conflictId}`,
      now,
    });

    await recordAuditEvent(tx, {
      shopId: input.shopId,
      actorUserId: input.actorUserId,
      eventType: 'stock.conflict_resolved',
      entityType: 'stock_conflict',
      entityId: updated.id,
    });

    return view;
  });
}
