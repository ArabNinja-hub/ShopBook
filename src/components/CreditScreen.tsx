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
import { Banner } from './ui/Banner';
import { Modal } from './ui/Modal';

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
        setStatusMessage(`Added customer "${created.name}" to the credit book.`);
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
        repayMethod === 'mobile_money' ? 'Mobile Money (recorded by hand)' : 'Cash';
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

  const renderCustomerModal = () => (
    <Modal
      isOpen={isCustomerModalOpen}
      onClose={() => setIsCustomerModalOpen(false)}
      title={isEditingCustomer ? 'Edit customer' : 'Add customer'}
      closeLabel="Close customer"
      dismissible={!isSavingCustomer}
    >
      {errorMessage && (
        <Banner tone="error" onDismiss={() => setErrorMessage(null)}>
          {errorMessage}
        </Banner>
      )}
      <form onSubmit={handleSaveCustomer}>
        <div className="sb-field">
          <label className="sb-label" htmlFor="cust-name">
            Customer name
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
            Phone number (optional)
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
            Where they live or a note (optional)
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

        <div className="sb-dialog-actions">
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
            {isSavingCustomer ? 'Saving…' : 'Save customer'}
          </button>
        </div>
      </form>
    </Modal>
  );

  const renderRepaymentModal = () => {
    if (!repayTarget) return null;
    const balance = repayTarget.outstandingBalanceNgwee;

    return (
      <Modal
        isOpen
        onClose={() => setRepayTarget(null)}
        title={`Record a payment — ${repayTarget.customer.name}`}
        closeLabel="Close payment"
        dismissible={!isSavingRepayment}
      >
        <Banner tone="warning">
          This only updates the credit book in ShopBook. It does not move money.
          Check that you have the cash or mobile money first.
        </Banner>

        {errorMessage && (
          <Banner tone="error" onDismiss={() => setErrorMessage(null)}>
            {errorMessage}
          </Banner>
        )}

        <div className="sb-balance-row">
          <span>Owes now</span>
          <strong className="sb-balance-value">{formatNgwee(balance)}</strong>
          <button
            type="button"
            className="sb-btn sb-btn-sm"
            onClick={() => setRepayAmountInput(formatNgweePlain(balance))}
          >
            Pay full amount
          </button>
        </div>

        <form onSubmit={handleSaveRepayment}>
          <div className="sb-field">
            <label className="sb-label" htmlFor="repay-amount">
              Amount Received (Kwacha)
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

          <fieldset className="sb-fieldset">
            <legend className="sb-label">How did they pay?</legend>
            <div className="sb-segment sb-segment-2">
              <button
                type="button"
                className={`sb-segment-btn ${repayMethod === 'cash' ? 'is-selected' : ''}`}
                aria-pressed={repayMethod === 'cash'}
                onClick={() => setRepayMethod('cash')}
              >
                Cash
              </button>
              <button
                type="button"
                className={`sb-segment-btn ${repayMethod === 'mobile_money' ? 'is-selected' : ''}`}
                aria-pressed={repayMethod === 'mobile_money'}
                onClick={() => setRepayMethod('mobile_money')}
              >
                Mobile Money
              </button>
            </div>
          </fieldset>

          <div className="sb-field">
            <label className="sb-label" htmlFor="repay-note">
              Note or reference (optional)
            </label>
            <input
              id="repay-note"
              type="text"
              className="sb-input"
              placeholder="e.g. Airtel Money ref"
              value={repayNoteInput}
              onChange={(e) => setRepayNoteInput(e.target.value)}
            />
          </div>

          <div className="sb-dialog-actions">
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
              {isSavingRepayment ? 'Saving…' : 'Confirm payment'}
            </button>
          </div>
        </form>
      </Modal>
    );
  };

  // Customer statement detail view
  if (selectedCustomerId && statementSummary) {
    const owing = statementSummary.outstandingBalanceNgwee;

    return (
      <div>
        <button
          type="button"
          className="sb-back-btn"
          onClick={() => setSelectedCustomerId(null)}
        >
          ← Back to credit
        </button>

        {statusMessage && (
          <Banner tone="success" onDismiss={() => setStatusMessage(null)}>
            {statusMessage}
          </Banner>
        )}

        <div className="sb-card">
          <div className="sb-card-header">
            <div>
              <h1 className="sb-card-title sb-statement-title">
                {statementSummary.customer.name}
              </h1>
              <p className="sb-card-subtitle">
                {statementSummary.customer.phone || 'No phone number'}
                {statementSummary.customer.notes
                  ? ` · ${statementSummary.customer.notes}`
                  : ''}
              </p>
            </div>
            <button
              type="button"
              className="sb-btn sb-btn-sm"
              onClick={() => openEditCustomerModal(statementSummary)}
            >
              Edit details
            </button>
          </div>

          <div
            className={`sb-balance-card ${owing > 0 ? 'is-owing' : 'is-settled'}`}
          >
            <div>
              <div className="sb-balance-label">
                {owing > 0 ? 'Money owed' : 'Fully paid'}
              </div>
              <div className="sb-balance-value">{formatNgwee(owing)}</div>
            </div>
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              disabled={owing <= 0}
              onClick={() => openRepaymentModal(statementSummary)}
            >
              {owing > 0 ? 'Record payment' : 'Paid up'}
            </button>
          </div>

          <p className="sb-hint">
            Credit taken: {formatNgwee(statementSummary.totalCreditNgwee)} ·
            Repaid: {formatNgwee(statementSummary.totalRepaidNgwee)}
          </p>

          <h2 className="sb-section-title">History</h2>
          {isLoadingStatement ? (
            <p className="sb-empty-text">Loading history…</p>
          ) : ledgerEntries.length === 0 ? (
            <p className="sb-empty-text">
              Nothing recorded yet. Choose <strong>Credit Book</strong> on the
              Sell screen to give this customer goods on credit.
            </p>
          ) : (
            <ul className="sb-list-divider">
              {ledgerEntries.map((entry) => {
                const isCharge = entry.type === 'credit_sale';
                return (
                  <li key={entry.id} className="sb-history-row">
                    <div className="sb-history-text">
                      <span className="sb-history-name">
                        {isCharge
                          ? 'Bought on credit'
                          : `Payment (${entry.paymentMethod === 'mobile_money' ? 'Mobile Money' : 'Cash'})`}
                      </span>
                      <span className="sb-history-meta">
                        {formatDateTimeReadable(entry.createdAt)}
                        {entry.note ? ` · ${entry.note}` : ''}
                      </span>
                    </div>
                    <div className="sb-history-change">
                      <span
                        className={
                          isCharge
                            ? 'sb-history-delta is-down'
                            : 'sb-history-delta is-up'
                        }
                      >
                        {isCharge ? '+' : '−'}
                        {formatNgwee(entry.amountNgwee)}
                      </span>
                      <span className="sb-history-meta">
                        Balance {formatNgwee(entry.runningBalanceNgwee)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {renderCustomerModal()}
        {renderRepaymentModal()}
      </div>
    );
  }

  return (
    <div>
      <header className="sb-page-head">
        <h1 className="sb-page-title">Credit</h1>
        <p className="sb-page-subtitle">Who owes you money, and what they paid.</p>
      </header>

      {statusMessage && (
        <Banner tone="success" onDismiss={() => setStatusMessage(null)}>
          {statusMessage}
        </Banner>
      )}
      {errorMessage && !isCustomerModalOpen && !repayTarget && (
        <Banner tone="error" onDismiss={() => setErrorMessage(null)}>
          {errorMessage}
        </Banner>
      )}

      <div className="sb-card sb-credit-summary">
        <div>
          <div className="sb-stat-label">Money owed to you</div>
          <div className="sb-stat-value">{formatNgwee(totals.totalOwingNgwee)}</div>
          <div className="sb-stat-caption">
            {totals.owingCount === 0
              ? 'Nobody owes you money'
              : `Across ${totals.owingCount} ${totals.owingCount === 1 ? 'customer' : 'customers'}`}
          </div>
        </div>
        <button
          type="button"
          className="sb-btn sb-btn-primary"
          onClick={openAddCustomerModal}
        >
          Add customer
        </button>
      </div>

      <div className="sb-search-wrap sb-search-row">
        <input
          type="search"
          className="sb-input"
          placeholder="Search by name or phone…"
          aria-label="Search customers"
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

      <div className="sb-pills" role="group" aria-label="Credit filters">
        <button
          type="button"
          className={`sb-pill ${!filterOwingOnly ? 'is-active' : ''}`}
          aria-pressed={!filterOwingOnly}
          onClick={() => setFilterOwingOnly(false)}
        >
          All customers ({customers.length})
        </button>
        <button
          type="button"
          className={`sb-pill ${filterOwingOnly ? 'is-active' : ''}`}
          aria-pressed={filterOwingOnly}
          onClick={() => setFilterOwingOnly(true)}
        >
          Owing money ({totals.owingCount})
        </button>
      </div>

      {filteredCustomers.length === 0 ? (
        <div className="sb-card sb-empty-state">
          <p className="sb-empty-text">
            {customers.length === 0
              ? 'No customers in your credit book yet. Add the people you sell to on credit.'
              : 'No customer matches that.'}
          </p>
          {customers.length === 0 && (
            <button
              type="button"
              className="sb-btn sb-btn-primary"
              onClick={openAddCustomerModal}
            >
              Add customer
            </button>
          )}
        </div>
      ) : (
        <ul className="sb-product-list">
          {filteredCustomers.map((summary) => {
            const owing = summary.outstandingBalanceNgwee;
            return (
              <li key={summary.customer.id} className="sb-product-row is-credit-row">
                <div className="sb-product-info">
                  <div className="sb-product-name">{summary.customer.name}</div>
                  <div className="sb-product-meta">
                    {summary.customer.phone && <span>{summary.customer.phone}</span>}
                    {owing > 0 ? (
                      <span className="sb-badge sb-badge-low">
                        Owes {formatNgwee(owing)}
                      </span>
                    ) : (
                      <span className="sb-badge sb-badge-ok">Paid up</span>
                    )}
                  </div>
                </div>

                <div className="sb-row-actions">
                  {owing > 0 && (
                    <button
                      type="button"
                      className="sb-btn sb-btn-primary sb-btn-sm"
                      onClick={() => openRepaymentModal(summary)}
                    >
                      Record payment
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
              </li>
            );
          })}
        </ul>
      )}

      {renderCustomerModal()}
      {renderRepaymentModal()}
    </div>
  );
};
