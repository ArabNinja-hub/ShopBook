import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SyncOperationEnvelope } from '../../src/shared/syncTypes';
import { ServerConfig } from '../config';
import { DatabaseContext } from '../db/client';
import { BadRequestError, ForbiddenError } from '../errors';
import { buildRequireAuth } from '../middleware/auth';
import { SlidingWindowRateLimiter } from '../middleware/rateLimit';
import { getShopEntitlementView } from '../services/entitlementService';
import {
  pullSyncLedger,
  pushSyncOperations,
  resolveStockConflict,
} from '../services/syncService';

const IsoTimestampSchema = z.string().min(10).max(64);
const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SafePositiveNgwee = z.number().int().positive().max(1_000_000_000_00);
const SafeNonNegNgwee = z.number().int().min(0).max(1_000_000_000_00);

const ProductRecordSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  unitLabel: z.string().max(40).default(''),
  sellingPriceNgwee: SafePositiveNgwee,
  costPriceNgwee: SafeNonNegNgwee.nullable(),
  stockQty: z.number().int().min(0).max(1_000_000),
  lowStockThreshold: z.number().int().min(0).max(1_000_000),
  isArchived: z.boolean(),
  isDemo: z.boolean().optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

const StockMovementRecordSchema = z.object({
  id: z.string().min(1).max(80),
  operationId: z.string().min(1).max(120),
  productId: z.string().min(1).max(80),
  productNameSnapshot: z.string().min(1).max(120),
  type: z.enum(['initial', 'sale', 'restock', 'adjustment']),
  deltaQty: z.number().int().min(-1_000_000).max(1_000_000),
  previousQty: z.number().int().min(0).max(1_000_000),
  newQty: z.number().int().min(0).max(1_000_000),
  reason: z.string().min(1).max(240),
  relatedSaleId: z.string().max(80).nullable(),
  isDemo: z.boolean().optional(),
  createdAt: IsoTimestampSchema,
});

const CustomerRecordSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(100),
  phone: z.string().max(30).default(''),
  notes: z.string().max(200).default(''),
  isDemo: z.boolean().optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

const SaleRecordSchema = z.object({
  id: z.string().min(1).max(80),
  operationId: z.string().min(1).max(120),
  receiptNumber: z.string().min(1).max(40),
  paymentMethod: z.enum(['cash', 'mobile_money', 'credit']),
  paymentReference: z.string().max(80).nullable(),
  customerId: z.string().max(80).nullable(),
  customerNameSnapshot: z.string().max(100).nullable(),
  totalNgwee: SafePositiveNgwee,
  totalUnits: z.number().int().positive().max(1_000_000),
  knownCostTotalNgwee: SafeNonNegNgwee,
  knownCostRevenueNgwee: SafeNonNegNgwee,
  missingCostLineCount: z.number().int().min(0).max(10_000),
  missingCostRevenueNgwee: SafeNonNegNgwee,
  note: z.string().max(200).default(''),
  isDemo: z.boolean().optional(),
  createdAt: IsoTimestampSchema,
  localDate: LocalDateSchema,
});

const SaleItemRecordSchema = z.object({
  id: z.string().min(1).max(80),
  saleId: z.string().min(1).max(80),
  productId: z.string().min(1).max(80),
  productNameAtSale: z.string().min(1).max(120),
  unitLabelAtSale: z.string().max(40).default(''),
  sellingPriceAtSaleNgwee: SafePositiveNgwee,
  costPriceAtSaleNgwee: SafeNonNegNgwee.nullable(),
  quantity: z.number().int().positive().max(1_000_000),
  lineTotalNgwee: SafePositiveNgwee,
  isDemo: z.boolean().optional(),
  createdAt: IsoTimestampSchema,
});

const CreditTxRecordSchema = z.object({
  id: z.string().min(1).max(80),
  operationId: z.string().min(1).max(120),
  customerId: z.string().min(1).max(80),
  customerNameSnapshot: z.string().min(1).max(100),
  type: z.enum(['credit_sale', 'repayment']),
  amountNgwee: SafePositiveNgwee,
  paymentMethod: z.enum(['cash', 'mobile_money']).nullable(),
  relatedSaleId: z.string().max(80).nullable(),
  note: z.string().max(240).default(''),
  isDemo: z.boolean().optional(),
  createdAt: IsoTimestampSchema,
  localDate: LocalDateSchema,
});

const SyncOperationSchema = z.discriminatedUnion('opType', [
  z.object({
    operationId: z.string().min(1).max(120),
    opType: z.literal('shop.update_name'),
    createdAt: IsoTimestampSchema,
    payload: z.object({
      shopName: z.string().min(1).max(80),
      updatedAt: IsoTimestampSchema,
    }),
  }),
  z.object({
    operationId: z.string().min(1).max(120),
    opType: z.literal('product.create'),
    createdAt: IsoTimestampSchema,
    payload: z.object({
      product: ProductRecordSchema,
      initialMovement: StockMovementRecordSchema,
    }),
  }),
  z.object({
    operationId: z.string().min(1).max(120),
    opType: z.literal('product.update'),
    createdAt: IsoTimestampSchema,
    payload: z.object({
      productId: z.string().min(1).max(80),
      name: z.string().min(1).max(120),
      unitLabel: z.string().max(40).default(''),
      sellingPriceNgwee: SafePositiveNgwee,
      costPriceNgwee: SafeNonNegNgwee.nullable(),
      lowStockThreshold: z.number().int().min(0).max(1_000_000),
      updatedAt: IsoTimestampSchema,
    }),
  }),
  z.object({
    operationId: z.string().min(1).max(120),
    opType: z.literal('product.archive'),
    createdAt: IsoTimestampSchema,
    payload: z.object({
      productId: z.string().min(1).max(80),
      isArchived: z.boolean(),
      updatedAt: IsoTimestampSchema,
    }),
  }),
  z.object({
    operationId: z.string().min(1).max(120),
    opType: z.literal('stock.adjust'),
    createdAt: IsoTimestampSchema,
    payload: z.object({
      productId: z.string().min(1).max(80),
      mode: z.enum(['add', 'subtract', 'set']),
      quantity: z.number().int().min(0).max(1_000_000),
      movement: StockMovementRecordSchema,
      updatedAt: IsoTimestampSchema,
    }),
  }),
  z.object({
    operationId: z.string().min(1).max(120),
    opType: z.literal('customer.create'),
    createdAt: IsoTimestampSchema,
    payload: z.object({
      customer: CustomerRecordSchema,
    }),
  }),
  z.object({
    operationId: z.string().min(1).max(120),
    opType: z.literal('customer.update'),
    createdAt: IsoTimestampSchema,
    payload: z.object({
      customerId: z.string().min(1).max(80),
      name: z.string().min(1).max(100),
      phone: z.string().max(30).default(''),
      notes: z.string().max(200).default(''),
      updatedAt: IsoTimestampSchema,
    }),
  }),
  z.object({
    operationId: z.string().min(1).max(120),
    opType: z.literal('sale.record'),
    createdAt: IsoTimestampSchema,
    payload: z.object({
      sale: SaleRecordSchema,
      saleItems: z.array(SaleItemRecordSchema).min(1).max(100),
      stockMovements: z.array(StockMovementRecordSchema).min(1).max(100),
      creditTransaction: CreditTxRecordSchema.nullable(),
    }),
  }),
  z.object({
    operationId: z.string().min(1).max(120),
    opType: z.literal('credit.repayment'),
    createdAt: IsoTimestampSchema,
    payload: z.object({
      repayment: CreditTxRecordSchema,
      customerUpdatedAt: IsoTimestampSchema,
    }),
  }),
]);

const PushBodySchema = z.object({
  operations: z.array(SyncOperationSchema).min(1).max(100),
});

const PullQuerySchema = z.object({
  afterCursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function registerSyncRoutes(
  app: FastifyInstance,
  dbCtx: DatabaseContext,
  config: ServerConfig
): Promise<void> {
  const syncRateLimiter = new SlidingWindowRateLimiter({
    maxRequests: 240,
    windowMs: 60 * 1000,
  });

  const requireShopMember = buildRequireAuth(dbCtx, config, [
    'owner',
    'cashier',
  ]);

  app.post(
    '/api/v1/sync/push',
    { preHandler: requireShopMember },
    async (request, reply) => {
      const auth = request.auth!;
      syncRateLimiter.consume(`sync-push:${auth.shop.id}:${request.ip}`);

      const parsed = PushBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const firstIssue = parsed.error.issues[0];
        throw new BadRequestError(
          firstIssue?.message ?? 'Invalid sync push payload.'
        );
      }

      // Check future entitlement hook (in Milestone 2, pilot shops always have allowNewSales = true;
      // even when future enforcement is enabled, repayments and existing history sync remain open)
      const entitlement = await getShopEntitlementView(
        dbCtx.db,
        auth.shop.id,
        config
      );
      if (!entitlement.allowNewSales) {
        const hasRestrictedOp = parsed.data.operations.some(
          (op) => op.opType === 'sale.record' || op.opType === 'product.create'
        );
        if (hasRestrictedOp) {
          throw new ForbiddenError(
            'Your plan is in read-only mode. Repayments and backups remain available, while new sales require an active plan.',
            'ENTITLEMENT_READ_ONLY'
          );
        }
      }

      const result = await pushSyncOperations(dbCtx, config, {
        shopId: auth.shop.id,
        actorUserId: auth.user.id,
        ipAddress: request.ip,
        operations: parsed.data.operations as SyncOperationEnvelope[],
      });

      return reply.status(200).send(result);
    }
  );

  app.get(
    '/api/v1/sync/pull',
    { preHandler: requireShopMember },
    async (request, reply) => {
      const auth = request.auth!;
      syncRateLimiter.consume(`sync-pull:${auth.shop.id}:${request.ip}`);

      const parsed = PullQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new BadRequestError('Invalid sync pull cursor parameters.');
      }

      const result = await pullSyncLedger(dbCtx, config, {
        shopId: auth.shop.id,
        afterCursor: parsed.data.afterCursor,
        limit: parsed.data.limit,
      });

      return reply.status(200).send(result);
    }
  );

  app.post(
    '/api/v1/sync/conflicts/:conflictId/resolve',
    { preHandler: requireShopMember },
    async (request, reply) => {
      const auth = request.auth!;
      const params = request.params as { conflictId?: string };
      if (!params.conflictId) {
        throw new BadRequestError('Missing conflict ID.');
      }

      const resolved = await resolveStockConflict(dbCtx, {
        shopId: auth.shop.id,
        actorUserId: auth.user.id,
        conflictId: params.conflictId,
      });

      return reply.status(200).send({ conflict: resolved });
    }
  );
}
