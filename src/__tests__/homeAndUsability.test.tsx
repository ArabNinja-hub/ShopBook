// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { resetDatabaseForTests } from '../db/indexedDb';
import { createCustomer } from '../services/creditService';
import { listSalesWithItems } from '../services/salesService';
import { createProduct, listProducts } from '../services/stockService';

const goToTab = (label: RegExp) => {
  fireEvent.click(screen.getAllByRole('button', { name: label })[0]);
};

const seedProduct = (overrides: Partial<Parameters<typeof createProduct>[0]> = {}) =>
  createProduct({
    name: 'Bread Loaf',
    unitLabel: 'loaf',
    sellingPriceNgwee: 2000,
    costPriceNgwee: 1500,
    initialStockQty: 5,
    ...overrides,
  });

describe('ShopBook home screen, sale confirmation and workflows', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens on Home with today sales, money owed, at most five low-stock items and three actions', async () => {
    for (let index = 1; index <= 6; index += 1) {
      await createProduct({
        name: `Low Item ${index}`,
        unitLabel: 'each',
        sellingPriceNgwee: 500,
        costPriceNgwee: null,
        initialStockQty: 1, // below the default threshold of 5
      });
    }

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('Sales today')).toBeInTheDocument();
    expect(screen.getByText('Money owed')).toBeInTheDocument();
    expect(screen.getByText('Nobody owes you money')).toBeInTheDocument();

    // Only the first five running-low items are surfaced on Home
    const runningLow = await screen.findByRole('region', { name: 'Running low' });
    expect(within(runningLow).getByText('Low Item 1')).toBeInTheDocument();
    expect(within(runningLow).getByText('5 items')).toBeInTheDocument();
    expect(within(runningLow).queryByText('Low Item 6')).not.toBeInTheDocument();

    // The three primary actions are present and lead somewhere useful
    expect(screen.getByRole('button', { name: /^Record a sale/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add a product/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^View credit/ }));
    expect(
      await screen.findByRole('heading', { name: 'Credit' })
    ).toBeInTheDocument();

    goToTab(/^Home/);
    fireEvent.click(screen.getByRole('button', { name: /^Record a sale/ }));
    expect(
      await screen.findByRole('heading', { name: 'Record a sale' })
    ).toBeInTheDocument();
  });

  it('confirms a sale once, survives a double-tap, and reflects it on Home', async () => {
    const product = await seedProduct({ initialStockQty: 5 });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^Record a sale/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Sell Bread Loaf' }));
    fireEvent.click(await screen.findByLabelText('Add one more Bread Loaf'));

    const confirmButton = screen.getByRole('button', {
      name: /Confirm sale · K40\.00/i,
    });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    // Exactly one confirmation, one receipt, one stock deduction
    await waitFor(() => {
      expect(screen.getAllByText(/saved: K40\.00/i)).toHaveLength(1);
    });
    const sales = await listSalesWithItems({ limit: 10 });
    expect(sales).toHaveLength(1);
    expect(sales[0].totalNgwee).toBe(4000);
    expect((await listProducts()).find((p) => p.id === product.id)?.stockQty).toBe(3);

    goToTab(/^Home/);
    expect(await screen.findByText('1 sale recorded')).toBeInTheDocument();
    expect(screen.getByText('K40.00')).toBeInTheDocument();
  });

  it('records a repayment and shows the remaining balance', async () => {
    const product = await seedProduct({
      name: 'Sugar 1kg',
      sellingPriceNgwee: 2000,
      initialStockQty: 3,
    });
    const customer = await createCustomer({ name: 'Mwape Tembo' });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^Record a sale/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sell Sugar 1kg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Credit Book' }));

    const customerSelect = screen.getByLabelText(/Customer Buying on Credit/i);
    fireEvent.change(customerSelect, { target: { value: customer.id } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm sale · K20\.00/i }));
    await screen.findByText(/saved: K20\.00/i);

    goToTab(/^Credit/);
    fireEvent.click(await screen.findByRole('button', { name: 'Record payment' }));
    fireEvent.change(screen.getByLabelText(/Amount Received \(Kwacha\)/i), {
      target: { value: '5.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm payment' }));

    expect(await screen.findByText(/Recorded repayment of K5\.00/i)).toBeInTheDocument();
    expect(await screen.findByText('Owes K15.00')).toBeInTheDocument();

    goToTab(/^Home/);
    expect(await screen.findByText('1 customer owes you')).toBeInTheDocument();
    expect(await screen.findByText('K15.00')).toBeInTheDocument();

    expect((await listProducts()).find((p) => p.id === product.id)?.stockQty).toBe(2);
  });

  it('never claims cloud sync when the ShopBook server is not reachable', async () => {
    render(<App />);

    // No API is available in this test environment, so the header must say so.
    expect(await screen.findByText('Saved on this phone')).toBeInTheDocument();
    expect(
      await screen.findByText(/saved on this phone only/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Synced with cloud/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Account and cloud sync/i }));
    expect(
      await screen.findByText(/Cloud sync is unavailable in this copy of ShopBook/i)
    ).toBeInTheDocument();
  });

  it('uses accessible dialog semantics, closes on Escape and returns focus to the opener', async () => {
    render(<App />);

    const settingsButton = await screen.findByRole('button', {
      name: /Settings and backups/i,
    });
    settingsButton.focus();
    fireEvent.click(settingsButton);

    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(settingsButton);
  });

  it('keeps training sample data separate and never overwrites real records', async () => {
    const realProduct = await seedProduct({ name: 'Real Salt 500g' });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Settings and backups/i }));
    fireEvent.click(await screen.findByRole('button', { name: /More options/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Load sample data/i }));

    const sampleDialog = await screen.findByRole('dialog', { name: 'Sample shop data' });
    expect(sampleDialog).toHaveTextContent(/training and demonstrations only/i);
    expect(sampleDialog).toHaveTextContent(/real records/i);

    fireEvent.click(
      screen.getByRole('button', { name: 'Load sample shop data' })
    );

    // Real records exist, so a confirmation is required before mixing in samples
    const confirmDialog = await screen.findByRole('dialog', {
      name: /Add sample records\?/i,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Add sample records' })
    );
    await waitFor(() => {
      expect(confirmDialog).not.toBeInTheDocument();
    });

    const afterLoad = await listProducts();
    expect(afterLoad.some((p) => p.isDemo)).toBe(true);
    expect(afterLoad.find((p) => p.id === realProduct.id)?.name).toBe('Real Salt 500g');

    // Removing samples deletes only [DEMO] rows
    fireEvent.click(await screen.findByRole('button', { name: /Remove sample data/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove sample records' })
    );

    await waitFor(async () => {
      const afterRemove = await listProducts();
      expect(afterRemove.some((p) => p.isDemo)).toBe(false);
      expect(afterRemove.find((p) => p.id === realProduct.id)?.name).toBe(
        'Real Salt 500g'
      );
    });
  });
});
