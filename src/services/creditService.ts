import { enqueueOutboxInTx, runTransaction, STORES } from '../db/indexedDb';
import {
  DuplicateOperationError,
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import { createId, toLocalDateKey } from '../domain/ids';
import { assertValidNgwee, formatNgwee } from '../domain/money';
import {
  CreditTransaction,
  Customer,
  CustomerCreditSummary,
  CustomerLedgerEntry,
  RepaymentPaymentMethod,
} from '../domain/types';

export interface CreateCustomerInput {
  name: string;
  phone?: string;
  notes?: string;
  now?: Date;
}

export interface UpdateCustomerInput {
  name: string;
  phone?: string;
  notes?: string;
  now?: Date;
}

export interface RecordRepaymentInput {
  /** Unique client operation ID preventing accidental duplicate repayment records */
  operationId: string;
  customerId: string;
  amountNgwee: number;
  paymentMethod: RepaymentPaymentMethod;
  note?: string;
  now?: Date;
}

function normalizeCustomerName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) {
    throw new ValidationError('Customer name is required.');
  }
  if (name.length > 100) {
    throw new ValidationError('Customer name must be 100 characters or fewer.');
  }
  return name;
}

/**
 * Pure helper that derives a customer's totals strictly from transaction records.
 */
export function computeCustomerTotalsFromTransactions(
  transactions: CreditTransaction[]
): {
  totalCreditNgwee: number;
  totalRepaidNgwee: number;
  outstandingBalanceNgwee: number;
} {
  let totalCreditNgwee = 0;
  let totalRepaidNgwee = 0;

  for (const tx of transactions) {
    if (tx.type === 'credit_sale') {
      totalCreditNgwee += tx.amountNgwee;
    } else if (tx.type === 'repayment') {
      totalRepaidNgwee += tx.amountNgwee;
    }
  }

  return {
    totalCreditNgwee,
    totalRepaidNgwee,
    outstandingBalanceNgwee: totalCreditNgwee - totalRepaidNgwee,
  };
}

/**
 * Creates a new customer in the credit book.
 */
export async function createCustomer(input: CreateCustomerInput): Promise<Customer> {
  const name = normalizeCustomerName(input.name);
  const phone = (input.phone ?? '').trim().slice(0, 30);
  const notes = (input.notes ?? '').trim().slice(0, 200);
  const nowIso = (input.now ?? new Date()).toISOString();

  const customer: Customer = {
    id: createId('cus'),
    name,
    phone,
    notes,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await runTransaction(
    [STORES.customers, STORES.syncOutbox],
    'readwrite',
    async (ctx) => {
      await ctx.add(STORES.customers, customer);
      await enqueueOutboxInTx(ctx, {
        operationId: createId('op'),
        opType: 'customer.create',
        createdAt: nowIso,
        payload: { customer },
      });
    }
  );

  return customer;
}

/**
 * Updates a customer's contact details.
 */
export async function updateCustomer(
  customerId: string,
  input: UpdateCustomerInput
): Promise<Customer> {
  const name = normalizeCustomerName(input.name);
  const phone = (input.phone ?? '').trim().slice(0, 30);
  const notes = (input.notes ?? '').trim().slice(0, 200);
  const nowIso = (input.now ?? new Date()).toISOString();

  return runTransaction(
    [STORES.customers, STORES.syncOutbox],
    'readwrite',
    async (ctx) => {
      const existing = await ctx.get(STORES.customers, customerId);
      if (!existing) {
        throw new NotFoundError('Customer not found.');
      }
      const updated: Customer = {
        ...existing,
        name,
        phone,
        notes,
        updatedAt: nowIso,
      };
      await ctx.put(STORES.customers, updated);
      if (!existing.isDemo) {
        await enqueueOutboxInTx(ctx, {
          operationId: createId('op'),
          opType: 'customer.update',
          createdAt: nowIso,
          payload: {
            customerId: updated.id,
            name: updated.name,
            phone: updated.phone,
            notes: updated.notes,
            updatedAt: nowIso,
          },
        });
      }
      return updated;
    }
  );
}

/**
 * Lists all customers with their transaction-computed credit balances.
 * Customers who owe money appear first (largest balance first), then alphabetically.
 */
export async function listCustomersWithBalances(): Promise<CustomerCreditSummary[]> {
  return runTransaction(
    [STORES.customers, STORES.creditTransactions],
    'readonly',
    async (ctx) => {
      const [customers, allTx] = await Promise.all([
        ctx.getAll(STORES.customers),
        ctx.getAll(STORES.creditTransactions),
      ]);

      const txByCustomer = new Map<string, CreditTransaction[]>();
      for (const tx of allTx) {
        const list = txByCustomer.get(tx.customerId);
        if (list) {
          list.push(tx);
        } else {
          txByCustomer.set(tx.customerId, [tx]);
        }
      }

      const summaries: CustomerCreditSummary[] = customers.map((customer) => {
        const txs = txByCustomer.get(customer.id) ?? [];
        const totals = computeCustomerTotalsFromTransactions(txs);
        let lastActivityAt = customer.updatedAt;
        for (const tx of txs) {
          if (tx.createdAt > lastActivityAt) {
            lastActivityAt = tx.createdAt;
          }
        }
        return {
          customer,
          ...totals,
          lastActivityAt,
        };
      });

      return summaries.sort((a, b) => {
        if (b.outstandingBalanceNgwee !== a.outstandingBalanceNgwee) {
          return b.outstandingBalanceNgwee - a.outstandingBalanceNgwee;
        }
        return a.customer.name.localeCompare(b.customer.name, undefined, {
          sensitivity: 'base',
        });
      });
    }
  );
}

/**
 * Returns a single customer's summary and full ledger statement with running balance.
 */
export async function getCustomerStatement(customerId: string): Promise<{
  summary: CustomerCreditSummary;
  /** Newest-first ledger entries, each showing the running balance right after that entry */
  entries: CustomerLedgerEntry[];
}> {
  return runTransaction(
    [STORES.customers, STORES.creditTransactions],
    'readonly',
    async (ctx) => {
      const customer = await ctx.get(STORES.customers, customerId);
      if (!customer) {
        throw new NotFoundError('Customer not found.');
      }

      const txs = await ctx.getAllByIndex(
        STORES.creditTransactions,
        'by_customerId',
        customerId
      );

      // Sort oldest-first to calculate accurate chronological running balances.
      // If a credit sale and repayment share the exact same timestamp, process credit_sale first.
      const chronological = [...txs].sort((a, b) => {
        const cmp = a.createdAt.localeCompare(b.createdAt);
        if (cmp !== 0) return cmp;
        if (a.type !== b.type) return a.type === 'credit_sale' ? -1 : 1;
        return a.id.localeCompare(b.id);
      });

      let running = 0;
      const withRunning: CustomerLedgerEntry[] = chronological.map((tx) => {
        if (tx.type === 'credit_sale') {
          running += tx.amountNgwee;
        } else {
          running -= tx.amountNgwee;
        }
        return {
          ...tx,
          runningBalanceNgwee: running,
        };
      });

      const totals = computeCustomerTotalsFromTransactions(chronological);
      const lastActivityAt =
        chronological.length > 0
          ? chronological[chronological.length - 1].createdAt
          : customer.updatedAt;

      return {
        summary: {
          customer,
          ...totals,
          lastActivityAt,
        },
        entries: withRunning.reverse(),
      };
    }
  );
}

/**
 * Records a debt repayment from a customer atomically.
 *
 * NOTE: Recording a repayment updates the shop's credit book only;
 * it does not process electronic money transfers.
 */
export async function recordRepayment(
  input: RecordRepaymentInput
): Promise<CreditTransaction> {
  const operationId = input.operationId.trim();
  if (!operationId) {
    throw new ValidationError('Missing operation ID for repayment.');
  }

  assertValidNgwee(input.amountNgwee, 'Repayment amount', false);

  if (input.paymentMethod !== 'cash' && input.paymentMethod !== 'mobile_money') {
    throw new ValidationError('Choose Cash or Mobile Money for the repayment method.');
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const localDate = toLocalDateKey(now);

  return runTransaction(
    [STORES.customers, STORES.creditTransactions, STORES.syncOutbox],
    'readwrite',
    async (ctx) => {
      // 1. Prevent accidental duplicate submission on double-tap
      const existingOp = await ctx.getOneByIndex(
        STORES.creditTransactions,
        'by_operationId',
        operationId
      );
      if (existingOp) {
        throw new DuplicateOperationError(
          operationId,
          'This repayment has already been recorded.'
        );
      }

      // 2. Verify customer exists
      const customer = await ctx.get(STORES.customers, input.customerId);
      if (!customer) {
        throw new NotFoundError('Customer not found.');
      }

      // 3. Calculate current outstanding balance strictly from existing transactions
      const existingTxs = await ctx.getAllByIndex(
        STORES.creditTransactions,
        'by_customerId',
        input.customerId
      );
      const { outstandingBalanceNgwee } =
        computeCustomerTotalsFromTransactions(existingTxs);

      if (outstandingBalanceNgwee <= 0) {
        throw new ValidationError(
          `${customer.name} currently has no outstanding credit balance (${formatNgwee(0)}).`
        );
      }

      if (input.amountNgwee > outstandingBalanceNgwee) {
        throw new ValidationError(
          `Repayment of ${formatNgwee(input.amountNgwee)} is higher than ${customer.name}'s owing balance of ${formatNgwee(outstandingBalanceNgwee)}.`
        );
      }

      const defaultNote =
        input.paymentMethod === 'mobile_money'
          ? 'Debt repayment (Mobile Money recorded)'
          : 'Debt repayment (Cash received)';

      const repaymentTx: CreditTransaction = {
        id: createId('crd'),
        operationId,
        customerId: customer.id,
        customerNameSnapshot: customer.name,
        type: 'repayment',
        amountNgwee: input.amountNgwee,
        paymentMethod: input.paymentMethod,
        relatedSaleId: null,
        note: (input.note ?? '').trim().slice(0, 200) || defaultNote,
        createdAt: nowIso,
        localDate,
      };

      await ctx.add(STORES.creditTransactions, repaymentTx);
      await ctx.put(STORES.customers, {
        ...customer,
        updatedAt: nowIso,
      });
      if (!customer.isDemo) {
        await enqueueOutboxInTx(ctx, {
          operationId,
          opType: 'credit.repayment',
          createdAt: nowIso,
          payload: {
            repayment: repaymentTx,
            customerUpdatedAt: nowIso,
          },
        });
      }

      return repaymentTx;
    }
  );
}
