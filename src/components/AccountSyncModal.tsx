import React, { useEffect, useState } from 'react';
import { formatDateTimeReadable, toLocalDateKey } from '../domain/ids';
import { formatZambianPhoneReadable } from '../shared/identifiers';
import { AuthSessionResponse } from '../shared/syncTypes';
import {
  confirmAccountPasswordReset,
  loginAccount,
  logoutAccount,
  registerOwnerAccount,
  requestAccountPasswordReset,
  rotateAccountRecoveryKey,
} from '../services/authClientService';
import {
  createFullBackupJson,
  downloadTextFile,
} from '../services/exportService';
import { Banner } from './ui/Banner';
import { Modal } from './ui/Modal';
import {
  bindLocalLedgerToShop,
  LocalSyncOverview,
  resetLocalStoresForShopSwitchOrSignOut,
  ShopBindingMismatchError,
  syncWithServer,
  UnboundLocalDataDecisionRequiredError,
} from '../services/syncClientService';

interface AccountSyncModalProps {
  isOpen: boolean;
  localShopName: string;
  session: AuthSessionResponse | null;
  syncOverview: LocalSyncOverview | null;
  isSyncing: boolean;
  /** null = still checking, false = no ShopBook API on this host. */
  apiReachable: boolean | null;
  onClose: () => void;
  onSessionChanged: (next: AuthSessionResponse) => void;
  onTriggerSync: () => Promise<void>;
  onDataChanged: () => Promise<void>;
}

type AuthFormMode = 'login' | 'register' | 'recover';

export const AccountSyncModal: React.FC<AccountSyncModalProps> = ({
  isOpen,
  localShopName,
  session,
  syncOverview,
  isSyncing,
  apiReachable,
  onClose,
  onSessionChanged,
  onTriggerSync,
  onDataChanged,
}) => {
  const [mode, setMode] = useState<AuthFormMode>('login');
  const [isBusy, setIsBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Registration fields
  const [regFullName, setRegFullName] = useState('');
  const [regShopName, setRegShopName] = useState(localShopName);
  const [regPhone, setRegPhone] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [claimLocalOnRegister, setClaimLocalOnRegister] = useState(true);

  // Login fields
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Recovery fields
  const [recoverIdentifier, setRecoverIdentifier] = useState('');
  const [recoverCode, setRecoverCode] = useState('');
  const [recoverNewPassword, setRecoverNewPassword] = useState('');

  // One-time Emergency Recovery Key banner
  const [newlyIssuedRecoveryKey, setNewlyIssuedRecoveryKey] = useState<
    string | null
  >(null);

  // Rotate recovery key fields
  const [showRotateKey, setShowRotateKey] = useState(false);
  const [rotatePassword, setRotatePassword] = useState('');

  // Shared-device sign-out confirmation state
  const [showSharedDeviceWipeConfirm, setShowSharedDeviceWipeConfirm] =
    useState(false);
  const [ackDiscardUnsynced, setAckDiscardUnsynced] = useState(false);

  // Pending decision when signing into an existing shop while unbound or mismatched local data exists
  const [pendingDecision, setPendingDecision] = useState<
    'unbound_local_data' | 'shop_mismatch' | null
  >(null);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setFeedback(null);
      setRegShopName(
        localShopName && localShopName !== 'My Shop' ? localShopName : ''
      );
      setShowSharedDeviceWipeConfirm(false);
      setAckDiscardUnsynced(false);
    }
  }, [isOpen, localShopName]);

  // Detect if signed-in session requires a local binding decision
  useEffect(() => {
    if (!session?.authenticated || !session.shop || !syncOverview) {
      setPendingDecision(null);
      return;
    }

    if (
      syncOverview.boundShopId !== null &&
      syncOverview.boundShopId !== session.shop.id
    ) {
      setPendingDecision('shop_mismatch');
    } else if (
      syncOverview.boundShopId === null &&
      (syncOverview.nonDemoLocalRecordCount > 0 ||
        syncOverview.pendingOutboxCount > 0)
    ) {
      setPendingDecision('unbound_local_data');
    } else {
      setPendingDecision(null);
    }
  }, [session, syncOverview]);

  if (!isOpen) return null;

  const isAuthenticated = Boolean(session?.authenticated && session.shop && session.user);
  const pendingCount = syncOverview?.pendingOutboxCount ?? 0;
  const nonDemoLocalCount = syncOverview?.nonDemoLocalRecordCount ?? 0;

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      const authRes = await registerOwnerAccount({
        fullName: regFullName,
        shopName: regShopName || localShopName || 'My Shop',
        phone: regPhone.trim() || undefined,
        email: regEmail.trim() || undefined,
        password: regPassword,
      });

      if (authRes.shop && authRes.user) {
        // Only auto-bind directly if the browser isn't bound to another shop
        if (
          !syncOverview?.boundShopId ||
          syncOverview.boundShopId === authRes.shop.id
        ) {
          await bindLocalLedgerToShop({
            shopId: authRes.shop.id,
            shopName: authRes.shop.name,
            userId: authRes.user.id,
            claimExistingLocalRecords: claimLocalOnRegister,
          });
          await syncWithServer({
            shop: authRes.shop,
            userId: authRes.user.id,
          });
        }
      }

      onSessionChanged(authRes);
      if (authRes.issuedRecoveryKey) {
        setNewlyIssuedRecoveryKey(authRes.issuedRecoveryKey);
      }
      await onDataChanged();
      setRegPassword('');
      setFeedback(
        'Pilot shop account created and synchronized! Save your Emergency Recovery Key below.'
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not create pilot account.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      const authRes = await loginAccount({
        identifier: loginIdentifier,
        password: loginPassword,
      });
      onSessionChanged(authRes);
      setLoginPassword('');

      if (authRes.shop && authRes.user) {
        try {
          await syncWithServer({
            shop: authRes.shop,
            userId: authRes.user.id,
          });
          await onDataChanged();
          setFeedback(`Signed in to ${authRes.shop.name} and synchronized.`);
        } catch (syncErr) {
          if (syncErr instanceof UnboundLocalDataDecisionRequiredError) {
            setPendingDecision('unbound_local_data');
          } else if (syncErr instanceof ShopBindingMismatchError) {
            setPendingDecision('shop_mismatch');
          } else {
            setError(
              syncErr instanceof Error
                ? syncErr.message
                : 'Signed in, but initial sync encountered an issue.'
            );
          }
          await onDataChanged();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleRecoverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      const res = await confirmAccountPasswordReset({
        identifier: recoverIdentifier,
        recoveryCode: recoverCode,
        newPassword: recoverNewPassword,
      });
      setNewlyIssuedRecoveryKey(res.issuedRecoveryKey);
      setRecoverCode('');
      setRecoverNewPassword('');
      setMode('login');
      setLoginIdentifier(recoverIdentifier);
      setFeedback(
        'Password reset complete! All old sessions were signed out. Copy your new Emergency Recovery Key below and sign in with your new password.'
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Account recovery failed.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRequestSupportReset = async () => {
    if (!recoverIdentifier.trim()) {
      setError('Enter your Zambian phone number or email address first.');
      return;
    }
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      const res = await requestAccountPasswordReset(recoverIdentifier);
      setFeedback(res.message);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not request password reset.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleSignOutKeepLocal = async () => {
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      await logoutAccount().catch(() => undefined);
      onSessionChanged({
        authenticated: false,
        user: null,
        shop: null,
        memberships: [],
      });
      await onDataChanged();
      setFeedback(
        'Signed out. Your offline shop records remain safely saved on this device.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleSignOutAndClearDevice = async () => {
    if (pendingCount > 0 && !ackDiscardUnsynced) {
      setError(
        `Please sync first, download a JSON backup, or tick the confirmation box acknowledging that ${pendingCount} unsynced offline record(s) will be erased from this device.`
      );
      return;
    }

    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      await logoutAccount().catch(() => undefined);
      await resetLocalStoresForShopSwitchOrSignOut({
        newShop: null,
        forceDiscardUnsynced: ackDiscardUnsynced,
      });
      onSessionChanged({
        authenticated: false,
        user: null,
        shop: null,
        memberships: [],
      });
      setShowSharedDeviceWipeConfirm(false);
      setAckDiscardUnsynced(false);
      await onDataChanged();
      setFeedback('Signed out and cleared local shop records from this device.');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not clear local records.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleMergeUnboundIntoShop = async () => {
    if (!session?.shop || !session.user) return;
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      await bindLocalLedgerToShop({
        shopId: session.shop.id,
        shopName: session.shop.name,
        userId: session.user.id,
        claimExistingLocalRecords: true,
      });
      await syncWithServer({
        shop: session.shop,
        userId: session.user.id,
      });
      setPendingDecision(null);
      await onDataChanged();
      setFeedback(
        `Uploaded local shop records and synchronized with ${session.shop.name}.`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to merge local shop records.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleReplaceLocalWithCloudShop = async (forceDiscard: boolean) => {
    if (!session?.shop || !session.user) return;
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      await resetLocalStoresForShopSwitchOrSignOut({
        newShop: {
          shopId: session.shop.id,
          shopName: session.shop.name,
          userId: session.user.id,
        },
        forceDiscardUnsynced: forceDiscard,
      });
      await syncWithServer({
        shop: session.shop,
        userId: session.user.id,
      });
      setPendingDecision(null);
      setAckDiscardUnsynced(false);
      await onDataChanged();
      setFeedback(`Loaded cloud records for ${session.shop.name}.`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to switch shop storage.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleDownloadSafetyBackup = async () => {
    setError(null);
    setIsBusy(true);
    try {
      const json = await createFullBackupJson();
      const dateStamp = toLocalDateKey();
      downloadTextFile(
        `shopbook-backup-${dateStamp}.json`,
        json,
        'application/json;charset=utf-8'
      );
      setFeedback('Downloaded safety JSON backup to this device.');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not export JSON backup.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRotateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    setIsBusy(true);
    try {
      const res = await rotateAccountRecoveryKey(rotatePassword);
      setNewlyIssuedRecoveryKey(res.issuedRecoveryKey);
      setRotatePassword('');
      setShowRotateKey(false);
      setFeedback('Generated a new Emergency Recovery Key. Save it safely below.');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not rotate recovery key.'
      );
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Account & Cloud Sync"
      closeLabel="Close account and sync modal"
      dismissible={!isBusy}
    >
        {apiReachable === false && (
          <Banner tone="info">
            <strong>Cloud sync is unavailable in this copy of ShopBook.</strong>{' '}
            The ShopBook server cannot be reached, so accounts cannot sign in
            here. Everything you record is still saved on this phone — open
            Settings to download a backup.
          </Banner>
        )}

        {/* One-time Emergency Recovery Key Display */}
        {newlyIssuedRecoveryKey && (
          <div
            className="sb-alert sb-alert-warn"
            role="alert"
            style={{ marginBottom: 12 }}
          >
            <div style={{ width: '100%' }}>
              <strong>Save Your Emergency Recovery Key Now:</strong>
              <div style={{ fontSize: '0.82rem', marginTop: 4 }}>
                Write this key in your physical shop cashbook or save it safely.
                It lets you reset a forgotten password without paid SMS and will{' '}
                <strong>not</strong> be shown again:
              </div>
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  background: '#ffffff',
                  border: '1px dashed var(--sb-amber-border)',
                  borderRadius: 6,
                  fontFamily: 'monospace',
                  fontSize: '1rem',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textAlign: 'center',
                }}
                data-testid="issued-recovery-key"
              >
                {newlyIssuedRecoveryKey}
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  marginTop: 8,
                  justifyContent: 'flex-end',
                }}
              >
                <button
                  type="button"
                  className="sb-btn sb-btn-sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(newlyIssuedRecoveryKey);
                    setFeedback('Recovery key copied to clipboard.');
                  }}
                >
                  Copy Key
                </button>
                <button
                  type="button"
                  className="sb-btn sb-btn-primary sb-btn-sm"
                  onClick={() => setNewlyIssuedRecoveryKey(null)}
                >
                  I Saved It
                </button>
              </div>
            </div>
          </div>
        )}

        {feedback && (
          <div className="sb-alert sb-alert-success" role="status">
            <span>{feedback}</span>
          </div>
        )}

        {error && (
          <div className="sb-alert sb-alert-error" role="alert">
            <span>{error}</span>
          </div>
        )}

        {!isAuthenticated ? (
          <>
            {/* Free Pilot Info Notice — Zero Payment Prompts */}
            <div
              style={{
                background: 'var(--sb-green-100)',
                border: '1px solid var(--sb-green-200)',
                borderRadius: 'var(--sb-radius)',
                padding: '10px 12px',
                marginBottom: 12,
                fontSize: '0.84rem',
              }}
            >
              <strong>Free Pilot Account:</strong> Back up your shop ledger to
              PostgreSQL and synchronize sales, stock, and customer credit
              across phones with no payment required. ShopBook also continues to
              work offline at all times.
            </div>

            {/* Auth Mode Switcher */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 6,
                marginBottom: 14,
              }}
            >
              <button
                type="button"
                className={`sb-btn sb-btn-sm ${mode === 'login' ? 'sb-btn-primary' : ''}`}
                onClick={() => {
                  setError(null);
                  setMode('login');
                }}
              >
                Sign In
              </button>
              <button
                type="button"
                className={`sb-btn sb-btn-sm ${mode === 'register' ? 'sb-btn-primary' : ''}`}
                onClick={() => {
                  setError(null);
                  setMode('register');
                }}
              >
                Create Account
              </button>
              <button
                type="button"
                className={`sb-btn sb-btn-sm ${mode === 'recover' ? 'sb-btn-primary' : ''}`}
                onClick={() => {
                  setError(null);
                  setMode('recover');
                }}
              >
                Recover
              </button>
            </div>

            {mode === 'login' && (
              <form onSubmit={handleLogin}>
                <div style={{ marginBottom: 10 }}>
                  <label className="sb-label" htmlFor="auth-login-identifier">
                    Zambian Phone or Email
                  </label>
                  <input
                    id="auth-login-identifier"
                    type="text"
                    className="sb-input"
                    placeholder="e.g. 0977123456 or owner@shop.zm"
                    value={loginIdentifier}
                    onChange={(e) => setLoginIdentifier(e.target.value)}
                    required
                  />
                </div>

                <div style={{ marginBottom: 14 }}>
                  <label className="sb-label" htmlFor="auth-login-password">
                    Password
                  </label>
                  <input
                    id="auth-login-password"
                    type="password"
                    className="sb-input"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="sb-btn sb-btn-primary"
                  style={{ width: '100%' }}
                  disabled={isBusy}
                >
                  {isBusy ? 'Signing In...' : 'Sign In & Sync Shop'}
                </button>
              </form>
            )}

            {mode === 'register' && (
              <form onSubmit={handleRegister}>
                <div style={{ marginBottom: 10 }}>
                  <label className="sb-label" htmlFor="auth-reg-fullname">
                    Owner Full Name
                  </label>
                  <input
                    id="auth-reg-fullname"
                    type="text"
                    className="sb-input"
                    placeholder="e.g. Chipo Mulenga"
                    value={regFullName}
                    onChange={(e) => setRegFullName(e.target.value)}
                    required
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label className="sb-label" htmlFor="auth-reg-shopname">
                    Shop Name
                  </label>
                  <input
                    id="auth-reg-shopname"
                    type="text"
                    className="sb-input"
                    placeholder="e.g. Mulenga General Dealers"
                    value={regShopName}
                    onChange={(e) => setRegShopName(e.target.value)}
                    required
                  />
                </div>

                <div className="sb-grid-2" style={{ marginBottom: 10 }}>
                  <div>
                    <label className="sb-label" htmlFor="auth-reg-phone">
                      Zambian Mobile (Airtel/MTN/Zamtel)
                    </label>
                    <input
                      id="auth-reg-phone"
                      type="tel"
                      className="sb-input"
                      placeholder="0977123456"
                      value={regPhone}
                      onChange={(e) => setRegPhone(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="sb-label" htmlFor="auth-reg-email">
                      Email (Optional if phone entered)
                    </label>
                    <input
                      id="auth-reg-email"
                      type="email"
                      className="sb-input"
                      placeholder="owner@example.com"
                      value={regEmail}
                      onChange={(e) => setRegEmail(e.target.value)}
                    />
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <label className="sb-label" htmlFor="auth-reg-password">
                    Password (8+ characters)
                  </label>
                  <input
                    id="auth-reg-password"
                    type="password"
                    className="sb-input"
                    minLength={8}
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    required
                  />
                </div>

                {nonDemoLocalCount > 0 && !syncOverview?.boundShopId && (
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      fontSize: '0.84rem',
                      marginBottom: 12,
                      padding: '8px 10px',
                      background: 'var(--sb-surface-subtle)',
                      border: '1px solid var(--sb-border)',
                      borderRadius: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={claimLocalOnRegister}
                      onChange={(e) =>
                        setClaimLocalOnRegister(e.target.checked)
                      }
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      Sync my existing local shop records ({nonDemoLocalCount}{' '}
                      real record{nonDemoLocalCount === 1 ? '' : 's'}) into this
                      new shop account.
                    </span>
                  </label>
                )}

                <button
                  type="submit"
                  className="sb-btn sb-btn-primary"
                  style={{ width: '100%' }}
                  disabled={isBusy}
                >
                  {isBusy
                    ? 'Creating Pilot Account...'
                    : 'Create Free Pilot Account'}
                </button>
              </form>
            )}

            {mode === 'recover' && (
              <form onSubmit={handleRecoverSubmit}>
                <div
                  style={{
                    fontSize: '0.82rem',
                    color: 'var(--sb-text-muted)',
                    marginBottom: 10,
                  }}
                >
                  Reset your password using your personal{' '}
                  <strong>Emergency Recovery Key</strong> (<code>SBRK-...</code>
                  ) or a single-use <strong>Pilot Support Reset Code</strong> (
                  <code>SBRST-...</code>).
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label className="sb-label" htmlFor="auth-rec-identifier">
                    Zambian Phone or Email
                  </label>
                  <input
                    id="auth-rec-identifier"
                    type="text"
                    className="sb-input"
                    placeholder="0977123456 or owner@example.com"
                    value={recoverIdentifier}
                    onChange={(e) => setRecoverIdentifier(e.target.value)}
                    required
                  />
                </div>

                <div style={{ marginBottom: 10 }}>
                  <label className="sb-label" htmlFor="auth-rec-code">
                    Emergency Recovery Key or Reset Code
                  </label>
                  <input
                    id="auth-rec-code"
                    type="text"
                    className="sb-input"
                    placeholder="SBRK-XXXX-XXXX-XXXX"
                    value={recoverCode}
                    onChange={(e) => setRecoverCode(e.target.value)}
                    required
                  />
                </div>

                <div style={{ marginBottom: 12 }}>
                  <label className="sb-label" htmlFor="auth-rec-newpass">
                    New Password (8+ characters)
                  </label>
                  <input
                    id="auth-rec-newpass"
                    type="password"
                    className="sb-input"
                    minLength={8}
                    value={recoverNewPassword}
                    onChange={(e) => setRecoverNewPassword(e.target.value)}
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="sb-btn sb-btn-primary"
                  style={{ width: '100%', marginBottom: 8 }}
                  disabled={isBusy}
                >
                  {isBusy ? 'Resetting Password...' : 'Reset Password'}
                </button>

                <button
                  type="button"
                  className="sb-btn sb-btn-sm"
                  style={{ width: '100%' }}
                  disabled={isBusy}
                  onClick={handleRequestSupportReset}
                >
                  Log Support Reset Request (No Recovery Key?)
                </button>
              </form>
            )}
          </>
        ) : (
          /* Signed-In Account & Synchronization Dashboard */
          <div>
            <div
              style={{
                padding: 12,
                borderRadius: 'var(--sb-radius)',
                border: '1px solid var(--sb-border)',
                background: 'var(--sb-surface-subtle)',
                marginBottom: 12,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: '1rem' }}>
                    {session!.shop!.name}
                  </div>
                  <div
                    style={{
                      fontSize: '0.82rem',
                      color: 'var(--sb-text-muted)',
                    }}
                  >
                    {session!.user!.fullName} ({session!.shop!.role})
                    {session!.user!.phoneE164
                      ? ` · ${formatZambianPhoneReadable(session!.user!.phoneE164)}`
                      : ''}
                    {session!.user!.email ? ` · ${session!.user!.email}` : ''}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: 999,
                    background: 'var(--sb-green-100)',
                    color: 'var(--sb-green-700)',
                    border: '1px solid var(--sb-green-200)',
                  }}
                >
                  {session!.shop!.entitlement.statusLabel}
                </span>
              </div>

              <div
                style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: '1px solid var(--sb-border)',
                  fontSize: '0.82rem',
                  display: 'grid',
                  gap: 4,
                }}
              >
                <div>
                  <strong>Pending offline changes:</strong> {pendingCount}
                </div>
                <div>
                  <strong>Last cloud sync:</strong>{' '}
                  {syncOverview?.lastSyncedAt
                    ? formatDateTimeReadable(syncOverview.lastSyncedAt)
                    : 'Not synced yet'}
                </div>
                {session!.user!.recoveryCodeHint && (
                  <div>
                    <strong>Active recovery key:</strong>{' '}
                    <code>{session!.user!.recoveryCodeHint}</code>
                  </div>
                )}
                {syncOverview?.lastSyncError && (
                  <div style={{ color: 'var(--sb-red-text)', marginTop: 2 }}>
                    Last sync note: {syncOverview.lastSyncError}
                  </div>
                )}
              </div>
            </div>

            {/* Guard Prompt when Local Data Needs Explicit Merge/Switch Confirmation */}
            {pendingDecision === 'unbound_local_data' && (
              <div className="sb-alert sb-alert-warn" style={{ marginBottom: 12 }}>
                <div style={{ width: '100%', fontSize: '0.84rem' }}>
                  <strong>Existing Local Shop Records Found:</strong>
                  <div style={{ marginTop: 4 }}>
                    This browser already has local shop records recorded before
                    signing in. How would you like to proceed with{' '}
                    <strong>{session!.shop!.name}</strong>?
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gap: 8,
                      marginTop: 10,
                    }}
                  >
                    <button
                      type="button"
                      className="sb-btn sb-btn-primary sb-btn-sm"
                      disabled={isBusy}
                      onClick={handleMergeUnboundIntoShop}
                    >
                      Upload &amp; Merge Local Records into {session!.shop!.name}
                    </button>
                    <button
                      type="button"
                      className="sb-btn sb-btn-sm"
                      disabled={isBusy}
                      onClick={handleDownloadSafetyBackup}
                    >
                      Download Safety JSON Backup First
                    </button>
                    <button
                      type="button"
                      className="sb-btn sb-btn-danger sb-btn-sm"
                      disabled={isBusy}
                      onClick={() => handleReplaceLocalWithCloudShop(true)}
                    >
                      Replace Local Records with Cloud Shop
                    </button>
                  </div>
                </div>
              </div>
            )}

            {pendingDecision === 'shop_mismatch' && (
              <div className="sb-alert sb-alert-warn" style={{ marginBottom: 12 }}>
                <div style={{ width: '100%', fontSize: '0.84rem' }}>
                  <strong>Different Shop Stored on This Device:</strong>
                  <div style={{ marginTop: 4 }}>
                    Local storage currently holds data for{' '}
                    <strong>{syncOverview?.boundShopName ?? 'another shop'}</strong>
                    {pendingCount > 0
                      ? ` — including ${pendingCount} UNSYNCED offline record(s)!`
                      : '.'}
                  </div>
                  <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                    <button
                      type="button"
                      className="sb-btn sb-btn-sm"
                      disabled={isBusy}
                      onClick={handleDownloadSafetyBackup}
                    >
                      Download JSON Backup of Current Device Data
                    </button>
                    {pendingCount > 0 && (
                      <label
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'flex-start',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={ackDiscardUnsynced}
                          onChange={(e) =>
                            setAckDiscardUnsynced(e.target.checked)
                          }
                        />
                        <span>
                          I understand switching shops will discard{' '}
                          {pendingCount} unsynced record(s) from the previous
                          shop.
                        </span>
                      </label>
                    )}
                    <button
                      type="button"
                      className="sb-btn sb-btn-danger sb-btn-sm"
                      disabled={
                        isBusy || (pendingCount > 0 && !ackDiscardUnsynced)
                      }
                      onClick={() =>
                        handleReplaceLocalWithCloudShop(ackDiscardUnsynced)
                      }
                    >
                      Switch Device Storage to {session!.shop!.name}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Primary Sync Button */}
            {!pendingDecision && (
              <button
                type="button"
                className="sb-btn sb-btn-primary"
                style={{ width: '100%', marginBottom: 12 }}
                disabled={isBusy || isSyncing}
                onClick={async () => {
                  setError(null);
                  setFeedback(null);
                  try {
                    await onTriggerSync();
                    setFeedback('Shop records synchronized with cloud ledger.');
                  } catch (err) {
                    setError(
                      err instanceof Error
                        ? err.message
                        : 'Synchronization failed.'
                    );
                  }
                }}
              >
                {isSyncing
                  ? 'Synchronizing...'
                  : pendingCount > 0
                    ? `Sync Now (${pendingCount} Pending)`
                    : 'Sync Now'}
              </button>
            )}

            {/* Rotate Recovery Key */}
            <div style={{ marginBottom: 12 }}>
              <button
                type="button"
                className="sb-btn sb-btn-sm"
                style={{ width: '100%' }}
                disabled={isBusy}
                onClick={() => setShowRotateKey((s) => !s)}
              >
                {showRotateKey
                  ? 'Cancel Recovery Key Rotation'
                  : 'Generate New Emergency Recovery Key'}
              </button>

              {showRotateKey && (
                <form
                  onSubmit={handleRotateKey}
                  style={{
                    marginTop: 8,
                    padding: 10,
                    border: '1px solid var(--sb-border)',
                    borderRadius: 8,
                  }}
                >
                  <label className="sb-label" htmlFor="rotate-current-pw">
                    Confirm Current Password
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      id="rotate-current-pw"
                      type="password"
                      className="sb-input"
                      value={rotatePassword}
                      onChange={(e) => setRotatePassword(e.target.value)}
                      required
                    />
                    <button
                      type="submit"
                      className="sb-btn sb-btn-primary sb-btn-sm"
                      disabled={isBusy}
                    >
                      Rotate Key
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Sign Out Controls with Pending Sync Protection */}
            <div
              style={{
                paddingTop: 12,
                borderTop: '1px solid var(--sb-border)',
                display: 'grid',
                gap: 8,
              }}
            >
              <button
                type="button"
                className="sb-btn sb-btn-sm"
                disabled={isBusy}
                onClick={handleSignOutKeepLocal}
              >
                Sign Out (Keep Offline Copy on My Phone)
              </button>

              {!showSharedDeviceWipeConfirm ? (
                <button
                  type="button"
                  className="sb-btn sb-btn-danger sb-btn-sm"
                  disabled={isBusy}
                  onClick={() => setShowSharedDeviceWipeConfirm(true)}
                >
                  Sign Out &amp; Clear Device Data (Shared Phone)
                </button>
              ) : (
                <div className="sb-alert sb-alert-warn">
                  <div style={{ width: '100%', fontSize: '0.83rem' }}>
                    {pendingCount > 0 ? (
                      <>
                        <strong>
                          Warning: {pendingCount} offline record(s) have NOT
                          been synced yet!
                        </strong>
                        <div style={{ marginTop: 4 }}>
                          Clearing this device right now will permanently erase
                          those unsynced changes unless you sync or download a
                          JSON backup first.
                        </div>
                        <label
                          style={{
                            display: 'flex',
                            gap: 8,
                            alignItems: 'flex-start',
                            marginTop: 8,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={ackDiscardUnsynced}
                            onChange={(e) =>
                              setAckDiscardUnsynced(e.target.checked)
                            }
                          />
                          <span>
                            Discard {pendingCount} unsynced offline record(s)
                            and clear this device.
                          </span>
                        </label>
                      </>
                    ) : (
                      <div>
                        All local changes are synced. Confirm clearing local
                        records from this shared device?
                      </div>
                    )}

                    <div
                      style={{
                        display: 'flex',
                        gap: 8,
                        marginTop: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      {pendingCount > 0 && (
                        <button
                          type="button"
                          className="sb-btn sb-btn-sm"
                          disabled={isBusy}
                          onClick={handleDownloadSafetyBackup}
                        >
                          Download Backup First
                        </button>
                      )}
                      <button
                        type="button"
                        className="sb-btn sb-btn-danger sb-btn-sm"
                        disabled={
                          isBusy || (pendingCount > 0 && !ackDiscardUnsynced)
                        }
                        onClick={handleSignOutAndClearDevice}
                      >
                        Confirm Sign Out &amp; Clear Device
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn-sm"
                        disabled={isBusy}
                        onClick={() => {
                          setShowSharedDeviceWipeConfirm(false);
                          setAckDiscardUnsynced(false);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
    </Modal>
  );
};
