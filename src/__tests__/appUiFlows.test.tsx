// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { closeShopDatabase, resetDatabaseForTests } from '../db/indexedDb';
import { createProduct, listProducts } from '../services/stockService';
import { createCustomer, getCustomerStatement } from '../services/creditService';
import { createFullBackupJson } from '../services/exportService';
import { updateShopName } from '../services/shopService';

describe('ShopBook UI, Logo Assets, Cart Reconciliation & Browser Refresh Flows', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it('verifies official logo files exist on disk with valid PNG headers and render in the UI', async () => {
    const rootLogo = path.resolve(process.cwd(), 'ShopBook Ledger Logo.png');
    const webFullLogo = path.resolve(process.cwd(), 'public/brand/shopbook-logo.png');
    const webSquareIcon = path.resolve(process.cwd(), 'public/brand/shopbook-icon.png');

    for (const filePath of [rootLogo, webFullLogo, webSquareIcon]) {
      expect(fs.existsSync(filePath)).toBe(true);
      const buf = fs.readFileSync(filePath);
      // Verify standard 8-byte PNG signature
      expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    }

    render(<App />);

    const welcomeLogo = await screen.findByAltText(
      'ShopBook — Smarter Sales. Better Business.'
    );
    expect(welcomeLogo).toHaveAttribute('src', '/brand/shopbook-logo.png');

    const headerIcon = screen.getByAltText('ShopBook icon');
    expect(headerIcon).toHaveAttribute('src', '/brand/shopbook-icon.png');
  });

  it('keeps shop name synchronized between Welcome setup and Settings modal', async () => {
    render(<App />);

    const shopInput = await screen.findByLabelText('Shop name');
    fireEvent.change(shopInput, { target: { value: 'Kabwe Market Kiosk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Name' }));

    await waitFor(() => {
      expect(screen.getByText('Kabwe Market Kiosk')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Backup & Shop/i }));
    const modalNameInput = await screen.findByLabelText('Shop Display Name');
    expect(modalNameInput).toHaveValue('Kabwe Market Kiosk');
  });

  it('reconciles cart quantities and badge automatically when stock is lowered or product is archived', async () => {
    await createProduct({
      name: 'White Sugar 2kg',
      unitLabel: 'pack',
      sellingPriceNgwee: 6800,
      costPriceNgwee: 5900,
      initialStockQty: 4,
    });

    render(<App />);

    // Add 3 units of Sugar to cart on Sell screen
    const sellBtn = await screen.findByRole('button', { name: '+ Sell' });
    fireEvent.click(sellBtn);
    const addMoreBtn = await screen.findByLabelText('Add one more White Sugar 2kg');
    fireEvent.click(addMoreBtn);
    fireEvent.click(addMoreBtn);

    expect(screen.getByText(/Sell \(3\)/)).toBeInTheDocument();

    // Switch to Stock and set exact count down to 1
    fireEvent.click(screen.getByRole('button', { name: /^Stock/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Adjust Stock' }));
    fireEvent.click(screen.getByRole('button', { name: '= Set Count' }));
    const qtyInput = screen.getByLabelText(/Exact Physical Stock Count/i);
    fireEvent.change(qtyInput, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Stock Update' }));

    // Cart count automatically clamps from 3 down to 1!
    await waitFor(() => {
      expect(screen.getByText(/Sell \(1\)/)).toBeInTheDocument();
    });

    // Archive the product in Stock -> cart automatically clears to 0!
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(screen.queryByText(/Sell \(1\)/)).not.toBeInTheDocument();
    });
  });

  it('prevents double-tap duplicate sales in UI and preserves all records across simulated browser reload', async () => {
    const bread = await createProduct({
      name: 'Bread Loaf',
      unitLabel: 'loaf',
      sellingPriceNgwee: 2250,
      costPriceNgwee: 1850,
      initialStockQty: 5,
    });
    await createCustomer({
      name: 'Chipo Banda',
      phone: '0977554433',
    });

    const firstRender = render(<App />);

    // Add 2 loaves (K45.00) on Sell screen
    fireEvent.click(await screen.findByRole('button', { name: '+ Sell' }));
    fireEvent.click(await screen.findByLabelText('Add one more Bread Loaf'));

    // Select Credit Book and pick Chipo Banda in desktop checkout panel
    fireEvent.click(screen.getByRole('button', { name: 'Credit Book' }));
    const customerSelect = screen.getByLabelText(/Customer Buying on Credit/i);
    const options = customerSelect.querySelectorAll('option');
    fireEvent.change(customerSelect, { target: { value: options[1].value } });

    // Rapidly double-click Confirm Sale
    const confirmBtn = screen.getByRole('button', {
      name: /Confirm Sale · K45\.00/i,
    });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    await screen.findByText(/saved: K45\.00/i);

    // Verify stock deducted ONCE (5 - 2 = 3, NOT 5 - 4 = 1!)
    const afterSaleProducts = await listProducts();
    expect(afterSaleProducts.find((p) => p.id === bread.id)?.stockQty).toBe(3);

    // Simulate full browser page refresh: unmount React tree & close IndexedDB handle, then remount
    firstRender.unmount();
    await closeShopDatabase();

    render(<App />);
    expect(await screen.findByText('Low: 3 left')).toBeInTheDocument();

    // Navigate to Credit tab and verify K45.00 balance survived browser refresh
    fireEvent.click(screen.getAllByRole('button', { name: /Credit/ })[0]);
    expect(await screen.findByText('Owes K45.00')).toBeInTheDocument();

    // Navigate to Today tab and verify Sales Recorded = K45.00, Est. Gross Profit = K8.00
    fireEvent.click(screen.getAllByRole('button', { name: /^Today$/ })[0]);
    expect(await screen.findByText('1 sale recorded')).toBeInTheDocument();
    expect(screen.getByText('K8.00')).toBeInTheDocument();
  });

  it('completes mobile bottom-sheet checkout, blocks repayment overpayment & double-taps, and warns on swapped cost/selling prices', async () => {
    await updateShopName('Backup Source Shop');
    const backupSourceJson = await createFullBackupJson();
    await updateShopName('Working Shop');

    const oil = await createProduct({
      name: 'Cooking Oil 750ml',
      unitLabel: 'bottle',
      sellingPriceNgwee: 3500, // K35.00
      costPriceNgwee: null, // Missing cost price
      initialStockQty: 3,
    });
    const cust = await createCustomer({ name: 'Mwape Tembo' });

    render(<App />);

    // 1. Mobile Checkout Sheet flow (with Mobile Money manual disclaimer check, then Credit sale)
    fireEvent.click(await screen.findByRole('button', { name: '+ Sell' }));
    const mobileCheckoutBtn = screen.getByRole('button', {
      name: /Checkout & Confirm/i,
    });
    fireEvent.click(mobileCheckoutBtn);

    // Check Mobile Money manual disclaimer inside sheet
    fireEvent.click(screen.getAllByRole('button', { name: 'Mobile Money' })[1]);
    expect(
      screen.getAllByText(/ShopBook does not process MTN MoMo or Airtel Money/i)[0]
    ).toBeInTheDocument();

    // Switch to Credit Book inside mobile checkout sheet & confirm
    fireEvent.click(screen.getAllByRole('button', { name: 'Credit Book' })[1]);
    const selects = screen.getAllByLabelText(/Customer Buying on Credit/i);
    const mobileSelect = selects[selects.length - 1];
    fireEvent.change(mobileSelect, { target: { value: cust.id } });

    const confirmButtons = screen.getAllByRole('button', {
      name: /Confirm Sale · K35\.00/i,
    });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await screen.findByText(/saved: K35\.00/i);
    expect((await listProducts()).find((p) => p.id === oil.id)?.stockQty).toBe(2);

    // 2. Credit Screen: Over-repayment rejected, valid repayment double-click protected
    fireEvent.click(screen.getAllByRole('button', { name: /Credit/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Record Payment' }));

    const repayInput = screen.getByLabelText(/Amount Received \(Kwacha\)/i);
    fireEvent.change(repayInput, { target: { value: '50.00' } }); // > K35.00 owing
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Repayment' }));
    expect(
      await screen.findByText(/higher than Mwape Tembo's owing balance/i)
    ).toBeInTheDocument();

    // Now enter valid K15.00 and double-click Confirm Repayment
    fireEvent.change(repayInput, { target: { value: '15.00' } });
    const confirmRepayBtn = screen.getByRole('button', {
      name: 'Confirm Repayment',
    });
    fireEvent.click(confirmRepayBtn);
    fireEvent.click(confirmRepayBtn);

    await screen.findByText(/Recorded repayment of K15\.00/i);
    const stmt = await getCustomerStatement(cust.id);
    expect(stmt.summary.outstandingBalanceNgwee).toBe(2000); // K35 - K15 = K20 (deducted once!)

    // 3. Stock Screen: Warns when Cost Price > Selling Price (accidental swap)
    fireEvent.click(screen.getAllByRole('button', { name: /^Stock/ })[0]);
    fireEvent.click(await screen.findByRole('button', { name: '+ Add Product' }));
    fireEvent.change(screen.getByLabelText(/Selling Price/i), {
      target: { value: '20.00' },
    });
    fireEvent.change(screen.getByLabelText(/Cost Price/i), {
      target: { value: '25.00' },
    });
    expect(
      await screen.findByText(/Cost price is higher than selling price/i)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close modal'));

    // 4. Backup Restore in ShopSettingsModal updates modal shop name immediately without stale state
    fireEvent.click(screen.getByRole('button', { name: /Backup & Shop/i }));
    expect(await screen.findByLabelText('Shop Display Name')).toHaveValue(
      'Working Shop'
    );

    const origConfirm = window.confirm;
    window.confirm = () => true;
    try {
      const fileInput = document.querySelector(
        'input[type="file"]'
      ) as HTMLInputElement;
      const backupFile = new File([backupSourceJson], 'backup.json', {
        type: 'application/json',
      });
      // Polyfill Blob.prototype.text if needed in older jsdom versions
      if (typeof backupFile.text !== 'function') {
        Object.defineProperty(backupFile, 'text', {
          value: async () => backupSourceJson,
        });
      }
      fireEvent.change(fileInput, { target: { files: [backupFile] } });

      await waitFor(() => {
        expect(screen.getByLabelText('Shop Display Name')).toHaveValue(
          'Backup Source Shop'
        );
      });
    } finally {
      window.confirm = origConfirm;
    }
  });
});
