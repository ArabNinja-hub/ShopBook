import React, { useEffect, useMemo, useState } from 'react';
import { createId, formatDateTimeReadable } from '../domain/ids';
import {
  formatNgwee,
  formatNgweePlain,
  parseKwachaToNgwee,
} from '../domain/money';
import {
  CustomerCreditSummary,
  CustomerLedgerEntry,
  RepaymentPaymentMethod,
} from '../domain/types';
import {
  createCustomer,
  getCustomerStatement,
  recordRepayment,
  updateCustomer,
} from '../services/creditService';

interface CreditScreenProps {
  customers: CustomerCreditSummary[];
  onDataChanged: () => Promise<void>;
}

export const CreditScreen: React.FC<CreditScreenProps> = ({
  customers,
  onDataChanged,
}) => {
  const [search, setSearch] = useState('');
  const [filterOwingOnly, setFilterOwingOnly] = useState(false);

  // Selected customer statement view
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null
  );
  const [statementSummary, setStatementSummary] =
    useState<CustomerCreditSummary | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<CustomerLedgerEntry[]>([]);
  const [isLoadingStatement, setIsLoadingStatement] = useState(false);

  // Add / Edit Customer modal
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [isEditingCustomer, setIsEditingCustomer] = useState(false);
  const [custNameInput, setCustNameInput] = useState('');
  const [custPhoneInput, setCustPhoneInput] = useState('');
  const [custNotesInput, setCustNotesInput] = useState('');
  const [isSavingCustomer, setIsSavingCustomer] = useState(false);

  // Record Repayment modal
  const [repayTarget, setRepayTarget] = useState<CustomerCreditSummary | null>(
    null
  );
  const [repayOpId, setRepayOpId] = useState<string>(() => createId('op'));
  const [repayAmountInput, setRepayAmountInput] = useState('');
  const [repayMethod, setRepayMethod] =
    useState<RepaymentPaymentMethod>('cash');
  const [repayNoteInput, setRepayNoteInput] = useState('');
  const [isSavingRepayment, setIsSavingRepayment] = useState(false);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadStatement = async (customerId: string) => {
    setIsLoadingStatement(true);
    try {
      const result = await getCustomerStatement(customerId);
      setStatementSummary(result.summary);
      setLedgerEntries(result.entries);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not load customer history.'
      );
      setSelectedCustomerId(null);
    } finally {
      setIsLoadingStatement(false);
    }
  };

  useEffect(() => {
    if (selectedCustomerId) {
      void loadStatement(selectedCustomerId);
    } else {
      setStatementSummary(null);
      setLedgerEntries([]);
    }
  }, [selectedCustomerId, customers]);

  const totals = useMemo(() => {
    let totalOwingNgwee = 0;
    let owingCount = 0;
    for (const c of customers) {
      if (c.outstandingBalanceNgwee > 0) {
        totalOwingNgwee += c.outstandingBalanceNgwee;
        owingCount += 1;
      }
    }
    return { totalOwingNgwee, owingCount };
  }, [customers]);

  const filteredCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return customers.filter((c) => {
      if (filterOwingOnly && c.outstandingBalanceNgwee <= 0) return false;
      if (!q) return true;
      return (
        c.customer.name.toLowerCase().includes(q) ||
        c.customer.phone.toLowerCase().includes(q) ||
        c.customer.notes.toLowerCase().includes(q)
      );
    });
  }, [customers, filterOwingOnly, search]);

  const openAddCustomerModal = () => {
    setIsEditingCustomer(false);
    setCustNameInput('');
    setCustPhoneInput('');
    setCustNotesInput('');
    setErrorMessage(null);
    setIsCustomerModalOpen(true);
  };

  const openEditCustomerModal = (summary: CustomerCreditSummary) => {
    setIsEditingCustomer(true);
    setCustNameInput(summary.customer.name);
    setCustPhoneInput(summary.customer.phone);
    setCustNotesInput(summary.customer.notes);
    setErrorMessage(null);
    setIsCustomerModalOpen(true);
  };

  const openRepaymentModal = (summary: CustomerCreditSummary) => {
    setRepayTarget(summary);
    setRepayOpId(createId('op'));
    setRepayAmountInput('');
    setRepayMethod('cash');
    setRepayNoteInput('');
    setErrorMessage(null);
  };

  const handleSaveCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSavingCustomer) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSavingCustomer(true);

    try {
      if (isEditingCustomer && statementSummary) {
        const updated = await updateCustomer(statementSummary.customer.id, {
          name: custNameInput,
          phone: custPhoneInput,
          notes: custNotesInput,
        });
        setStatusMessage(`Updated customer "${updated.name}".`);
      } else {
        const created = await createCustomer({
          name: custNameInput,
          phone: custPhoneInput,
          notes: custNotesInput,
        });
        setStatusMessage(`Added customer "${created.name}" to credit book.`);
      }
      setIsCustomerModalOpen(false);
      await onDataChanged();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not save customer.'
      );
    } finally {
      setIsSavingCustomer(false);
    }
  };

  const handleSaveRepayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repayTarget || isSavingRepayment) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setIsSavingRepayment(true);

    try {
      const amountNgwee = parseKwachaToNgwee(repayAmountInput, {
        fieldLabel: 'Repayment amount',
        allowZero: false,
      });

      await recordRepayment({
        operationId: repayOpId,
        customerId: repayTarget.customer.id,
        amountNgwee,
        paymentMethod: repayMethod,
        note: repayNoteInput,
      });

      const methodLabel =
        repayMethod === 'mobile_money' ? 'Mobile Money (manual)' : 'Cash';
      setStatusMessage(
        `Recorded repayment of ${formatNgwee(amountNgwee)} (${methodLabel}) from ${repayTarget.customer.name}.`
      );
      setRepayTarget(null);
      await onDataChanged();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Could not record repayment.'
      );
    } finally {
      setIsSavingRepayment(false);
    }
  };

  // Customer Statement Detail View
  if (selectedCustomerId && statementSummary) {
    const owing = statementSummary.outstandingBalanceNgwee;
    return (
      <div>
        <div style={{ marginBottom: 10 }}>
          <button
            type="button"
            className="sb-btn sb-btn-sm"
            onClick={() => setSelectedCustomerId(null)}
          >
            ← Back to Customers
          </button>
        </div>

        {statusMessage && (
          <div className="sb-alert sb-alert-success" role="status">
            <span>{statusMessage}</span>
            <button
              type="button"
              className="sb-btn sb-btn-sm"
              onClick={() => setStatusMessage(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="sb-card">
          <div className="sb-card-header">
            <div>
              <h2 className="sb-card-title" style={{ fontSize: '1.12rem' }}>
                {statementSummary.customer.name}
              </h2>
              <div className="sb-card-subtitle">
                {statementSummary.customer.phone
                  ? `Phone: ${statementSummary.customer.phone}`
                  : 'No phone number recorded'}
                {statementSummary.customer.notes
                  ? ` · ${statementSummary.customer.notes}`
                  : ''}
              </div>
            </div>
            <button
              type="button"
              className="sb-btn sb-btn-sm"
              onClick={() => openEditCustomerModal(statementSummary)}
            >
              Edit Details
            </button>
          </div>

          <div
            style={{
              padding: 12,
              borderRadius: 'var(--sb-radius-sm)',
              backgroundColor:
                owing > 0 ? 'var(--sb-amber-bg)' : 'var(--sb-green-100)',
              border: `1px solid ${owing > 0 ? 'var(--sb-amber-border)' : 'var(--sb-green-200)'}`,
              marginBottom: 12,
            }}
          >
            <div className="sb-row-between">
              <div>
                <div style={{ fontSize: '0.8rem', fontWeight: 700 }}>
                  OUTSTANDING BALANCE OWED
                </div>
                <div
                  style={{
                    fontSize: '1.45rem',
                    fontWeight: 800,
                    color:
                      owing > 0 ? 'var(--sb-amber-text)' : 'var(--sb-pine-900)',
                  }}
                >
                  {formatNgwee(owing)}
                </div>
              </div>
              <button
                type="button"
                className="sb-btn sb-btn-primary"
                disabled={owing <= 0}
                onClick={() => openRepaymentModal(statementSummary)}
              >
                {owing > 0 ? 'Record Repayment' : 'Settled'}
              </button>
            </div>
            <div
              style={{
                marginTop: 8,
                fontSize: '0.8rem',
                color: 'var(--sb-text-muted)',
              }}
            >
              Total credit taken:{' '}
              <strong>{formatNgwee(statementSummary.totalCreditNgwee)}</strong>{' '}
              · Total repaid:{' '}
              <strong>{formatNgwee(statementSummary.totalRepaidNgwee)}</strong>
            </div>
          </div>

          <h3 style={{ margin: '0 0 8px', fontSize: '0.95rem' }}>
            Transaction History ({ledgerEntries.length})
          </h3>
          {isLoadingStatement ? (
            <p style={{ color: 'var(--sb-text-muted)' }}>Loading history...</p>
          ) : ledgerEntries.length === 0 ? (
            <p
              style={{
                margin: 0,
                fontSize: '0.88rem',
                color: 'var(--sb-text-muted)',
              }}
            >
              No credit sales or repayments recorded for this customer yet. To
              record a credit sale, choose <strong>Credit Book</strong> on the
              Sell screen.
            </p>
          ) : (
            <div className="sb-list-divider">
              {ledgerEntries.map((entry) => {
                const isCharge = entry.type === 'credit_sale';
                return (
                  <div key={entry.id} className="sb-row-between">
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                        {isCharge
                          ? 'Bought on Credit'
                          : `Repayment (${entry.paymentMethod === 'mobile_money' ? 'Mobile Money' : 'Cash'})`}
                      </div>
                      <div
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--sb-text-muted)',
                        }}
                      >
                        {formatDateTimeReadable(entry.createdAt)}
                        {entry.note ? ` · ${entry.note}` : ''}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div
                        style={{
                          fontWeight: 800,
                          color: isCharge
                            ? 'var(--sb-red-text)'
                            : 'var(--sb-green-700)',
                        }}
                      >
                        {isCharge ? '+' : '−'}
                        {formatNgwee(entry.amountNgwee)}
                      </div>
                      <div
                        style={{
                          fontSize: '0.76rem',
                          color: 'var(--sb-text-muted)',
                        }}
                      >
                        Bal: {formatNgwee(entry.runningBalanceNgwee)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {renderCustomerModal()}
        {renderRepaymentModal()}
      </div>
    );
  }

  function renderCustomerModal() {
    if (!isCustomerModalOpen) return null;
    return (
      <div
        className="sb-modal-backdrop"
        onClick={() => !isSavingCustomer && setIsCustomerModalOpen(false)}
      >
        <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
          <div className="sb-modal-header">
            <h2 className="sb-modal-title">
              {isEditingCustomer ? 'Edit Customer' : 'Add Credit Customer'}
            </h2>
            <button
              type="button"
              className="sb-close-btn"
              disabled={isSavingCustomer}
              onClick={() => setIsCustomerModalOpen(false)}
              aria-label="Close modal"
            >
              ×
            </button>
          </div>

          {errorMessage && (
            <div className="sb-alert sb-alert-error" role="alert">
              <span>{errorMessage}</span>
            </div>
          )}

          <form onSubmit={handleSaveCustomer}>
            <div className="sb-field">
              <label className="sb-label" htmlFor="cust-name">
                Customer Name *
              </label>
              <input
                id="cust-name"
                type="text"
                className="sb-input"
                placeholder="e.g. Mama Mulenga"
                value={custNameInput}
                onChange={(e) => setCustNameInput(e.target.value)}
                required
              />
            </div>

            <div className="sb-field">
              <label className="sb-label" htmlFor="cust-phone">
                Phone Number (optional)
              </label>
              <input
                id="cust-phone"
                type="tel"
                className="sb-input"
                placeholder="e.g. 0977123456"
                value={custPhoneInput}
                onChange={(e) => setCustPhoneInput(e.target.value)}
              />
            </div>

            <div className="sb-field">
              <label className="sb-label" htmlFor="cust-notes">
                Location or Notes (optional)
              </label>
              <input
                id="cust-notes"
                type="text"
                className="sb-input"
                placeholder="e.g. House near market gate"
                value={custNotesInput}
                onChange={(e) => setCustNotesInput(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="sb-btn"
                disabled={isSavingCustomer}
                onClick={() => setIsCustomerModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="sb-btn sb-btn-primary sb-btn-block"
                disabled={isSavingCustomer}
              >
                {isSavingCustomer ? 'Saving...' : 'Save Customer'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  function renderRepaymentModal() {
    if (!repayTarget) return null;
    const balance = repayTarget.outstandingBalanceNgwee;
    return (
      <div
        className="sb-modal-backdrop"
        onClick={() => !isSavingRepayment && setRepayTarget(null)}
      >
        <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
          <div className="sb-modal-header">
            <h2 className="sb-modal-title">
              Record Repayment — {repayTarget.customer.name}
            </h2>
            <button
              type="button"
              className="sb-close-btn"
              disabled={isSavingRepayment}
              onClick={() => setRepayTarget(null)}
              aria-label="Close modal"
            >
              ×
            </button>
          </div>

          <div className="sb-alert sb-alert-warn">
            <span>
              <strong>Debt-book record only:</strong> Recording a repayment
              updates this customer&apos;s balance in ShopBook; it does not
              transfer or process money electronically.
            </span>
          </div>

          {errorMessage && (
            <div className="sb-alert sb-alert-error" role="alert">
              <span>{errorMessage}</span>
            </div>
          )}

          <div
            className="sb-row-between"
            style={{
              padding: '10px 12px',
              borderRadius: 'var(--sb-radius-sm)',
              backgroundColor: 'var(--sb-surface-subtle)',
              border: '1px solid var(--sb-border)',
              marginBottom: 12,
            }}
          >
            <span>Currently Owing:</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: '1.1rem' }}>
                {formatNgwee(balance)}
              </strong>
              <button
                type="button"
                className="sb-btn sb-btn-sm"
                onClick={() => setRepayAmountInput(formatNgweePlain(balance))}
              >
                Pay Full
              </button>
            </div>
          </div>

          <form onSubmit={handleSaveRepayment}>
            <div className="sb-field">
              <label className="sb-label" htmlFor="repay-amount">
                Amount Received (Kwacha) *
              </label>
              <input
                id="repay-amount"
                type="text"
                inputMode="decimal"
                className="sb-input"
                placeholder="e.g. 50.00"
                value={repayAmountInput}
                onChange={(e) => setRepayAmountInput(e.target.value)}
                required
              />
            </div>

            <div className="sb-field">
              <span className="sb-label">How Was Payment Received?</span>
              <div className="sb-grid-2">
                <button
                  type="button"
                  className={`sb-pay-option ${repayMethod === 'cash' ? 'is-selected' : ''}`}
                  onClick={() => setRepayMethod('cash')}
                >
                  Cash
                </button>
                <button
                  type="button"
                  className={`sb-pay-option ${repayMethod === 'mobile_money' ? 'is-selected' : ''}`}
                  onClick={() => setRepayMethod('mobile_money')}
                >
                  Mobile Money (Manual)
                </button>
              </div>
            </div>

            <div className="sb-field">
              <label className="sb-label" htmlFor="repay-note">
                Note / Reference (optional)
              </label>
              <input
                id="repay-note"
                type="text"
                className="sb-input"
                placeholder="e.g. Paid cash at stall / Airtel Money ref"
                value={repayNoteInput}
                onChange={(e) => setRepayNoteInput(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="sb-btn"
                disabled={isSavingRepayment}
                onClick={() => setRepayTarget(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="sb-btn sb-btn-primary sb-btn-block"
                disabled={isSavingRepayment}
              >
                {isSavingRepayment ? 'Saving...' : 'Confirm Repayment'}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div>
      {statusMessage && (
        <div className="sb-alert sb-alert-success" role="status">
          <span>{statusMessage}</span>
          <button
            type="button"
            className="sb-btn sb-btn-sm"
            onClick={() => setStatusMessage(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="sb-card">
        <div className="sb-row-between" style={{ flexWrap: 'wrap' }}>
          <div>
            <div className="sb-metric-label">Total Outstanding Customer Credit</div>
            <div className="sb-metric-value">
              {formatNgwee(totals.totalOwingNgwee)}
            </div>
            <div style={{ fontSize: '0.83rem', color: 'var(--sb-text-muted)' }}>
              {totals.owingCount === 0
                ? 'No customers currently owe money'
                : `Owed across ${totals.owingCount} ${totals.owingCount === 1 ? 'customer' : 'customers'} (calculated from ledger)`}
            </div>
          </div>
          <button
            type="button"
            className="sb-btn sb-btn-primary"
            onClick={openAddCustomerModal}
          >
            + Add Customer
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <div className="sb-search-wrap">
          <input
            type="search"
            className="sb-input"
            placeholder="Search customer name or phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="sb-search-clear"
              aria-label="Clear search"
              onClick={() => setSearch('')}
            >
              ×
            </button>
          )}
        </div>
      </div>

      <div className="sb-pills">
        <button
          type="button"
          className={`sb-pill ${!filterOwingOnly ? 'is-active' : ''}`}
          onClick={() => setFilterOwingOnly(false)}
        >
          All Customers ({customers.length})
        </button>
        <button
          type="button"
          className={`sb-pill ${filterOwingOnly ? 'is-active' : ''}`}
          onClick={() => setFilterOwingOnly(true)}
        >
          Owing Money ({totals.owingCount})
        </button>
      </div>

      {filteredCustomers.length === 0 ? (
        <div className="sb-card" style={{ textAlign: 'center', padding: 22 }}>
          <p style={{ margin: '0 0 12px', color: 'var(--sb-text-muted)' }}>
            {customers.length === 0
              ? 'No customers in your credit book yet. Add regular customers here to track credit sales and repayments reliably.'
              : 'No matching customers found.'}
          </p>
          {customers.length === 0 && (
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={openAddCustomerModal}
            >
              + Add First Customer
            </button>
          )}
        </div>
      ) : (
        <div className="sb-product-list">
          {filteredCustomers.map((summary) => {
            const owing = summary.outstandingBalanceNgwee;
            return (
              <div
                key={summary.customer.id}
                className="sb-product-row"
                style={{ flexWrap: 'wrap' }}
              >
                <div className="sb-product-info" style={{ minWidth: 190 }}>
                  <div className="sb-product-name">{summary.customer.name}</div>
                  <div className="sb-product-meta">
                    {summary.customer.phone && (
                      <span>{summary.customer.phone}</span>
                    )}
                    {owing > 0 ? (
                      <span className="sb-badge sb-badge-low">
                        Owes {formatNgwee(owing)}
                      </span>
                    ) : (
                      <span className="sb-badge sb-badge-ok">
                        Settled · K0.00
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  {owing > 0 && (
                    <button
                      type="button"
                      className="sb-btn sb-btn-primary sb-btn-sm"
                      onClick={() => openRepaymentModal(summary)}
                    >
                      Record Payment
                    </button>
                  )}
                  <button
                    type="button"
                    className="sb-btn sb-btn-sm"
                    onClick={() => setSelectedCustomerId(summary.customer.id)}
                  >
                    Statement
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {renderCustomerModal()}
      {renderRepaymentModal()}
    </div>
  );
};
