// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildServerApp } from '../../server/app';
import { loadServerConfig } from '../../server/config';
import { createDatabaseContext, DatabaseContext } from '../../server/db/client';
import { runMigrations } from '../../server/db/migrate';
import { App } from '../App';
import { resetDatabaseForTests } from '../db/indexedDb';
import { FetchLike, setApiFetchAdapter } from '../services/apiClient';
import { createProduct } from '../services/stockService';

describe('Milestone 2 UI — Pilot Account Registration, Recovery Key, Sync & Shared-Device Warning', () => {
  let dbCtx: DatabaseContext;
  let app: FastifyInstance;
  let failNetwork = false;
  let cookiePair = '';

  beforeAll(async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'pglite://memory',
      COOKIE_SECURE: 'false',
    });
    dbCtx = await createDatabaseContext({ databaseUrl: config.databaseUrl });
    await runMigrations(dbCtx);
    app = await buildServerApp({ dbCtx, config });
  });

  afterAll(async () => {
    setApiFetchAdapter(null);
    await app.close();
    await dbCtx.close();
  });

  beforeEach(async () => {
    failNetwork = false;
    cookiePair = '';
    await resetDatabaseForTests();

    const adapter: FetchLike = async (url, init) => {
      if (failNetwork) {
        throw new Error('Offline mode');
      }
      const headers: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(
          init.headers as Record<string, string>
        )) {
          headers[k.toLowerCase()] = v;
        }
      }
      if (cookiePair) {
        headers.cookie = cookiePair;
      }
      const res = await app.inject({
        method: (init?.method ?? 'GET') as 'GET' | 'POST',
        url,
        headers,
        payload: typeof init?.body === 'string' ? init.body : undefined,
      });
      const setCookie = res.headers['set-cookie'];
      const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (rawCookie) {
        const pair = rawCookie.split(';')[0];
        cookiePair = pair.endsWith('=') ? '' : pair;
      }
      return new Response(res.body, {
        status: res.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    };

    setApiFetchAdapter(adapter);
  });

  afterEach(() => {
    cleanup();
  });

  it('registers a pilot account from the UI, syncs existing local records, shows recovery key, and guards unsynced clear on sign-out', async () => {
    // Seed an existing local product before creating an account
    await createProduct({
      name: 'Roller Meal 25kg',
      unitLabel: 'bag',
      sellingPriceNgwee: 28500,
      costPriceNgwee: 25000,
      initialStockQty: 6,
    });

    render(<App />);

    // Open Account & Cloud Sync modal
    const accountBtn = await screen.findByRole('button', {
      name: /Account and cloud sync/i,
    });
    fireEvent.click(accountBtn);

    // Switch to Create Account tab
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

    fireEvent.change(screen.getByLabelText('Owner Full Name'), {
      target: { value: 'Chipo Banda' },
    });
    fireEvent.change(screen.getByLabelText('Shop Name'), {
      target: { value: 'Banda Family Store' },
    });
    fireEvent.change(
      screen.getByLabelText(/Zambian Mobile \(Airtel\/MTN\/Zamtel\)/i),
      { target: { value: '0977445566' } }
    );
    fireEvent.change(screen.getByLabelText(/Password \(8\+ characters\)/i), {
      target: { value: 'BandaSafePass99' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Create Free Pilot Account' })
    );

    // Verify Emergency Recovery Key and Free Pilot Access badge appear with 0 pending changes
    const recoveryKeyEl = await screen.findByTestId('issued-recovery-key');
    expect(recoveryKeyEl.textContent).toMatch(/^SBRK-/);
    expect(screen.getByText('Free Pilot Access')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'I Saved It' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Close account and sync modal' })
    );

    // Now go offline and record a new product locally so 1 item sits unsynced in syncOutbox
    failNetwork = true;
    await createProduct({
      name: 'Offline Soap Bar',
      unitLabel: 'bar',
      sellingPriceNgwee: 1850,
      costPriceNgwee: 1400,
      initialStockQty: 12,
    });

    // Reopen Account modal -> verify pending sync warning blocks unconfirmed device wipe!
    fireEvent.click(
      screen.getByRole('button', { name: /Account and cloud sync/i })
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Pending offline changes:/i).parentElement
      ).toHaveTextContent('1');
    });

    fireEvent.click(
      screen.getByRole('button', {
        name: /Sign Out & Clear Device Data/i,
      })
    );

    expect(
      await screen.findByText(/1 offline record\(s\) have NOT been synced yet!/i)
    ).toBeInTheDocument();

    const confirmClearBtn = screen.getByRole('button', {
      name: /Confirm Sign Out & Clear Device/i,
    });
    expect(confirmClearBtn).toBeDisabled();
  });
});
