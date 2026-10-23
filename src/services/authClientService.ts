import { AuthSessionResponse } from '../shared/syncTypes';
import { apiRequest } from './apiClient';

export interface RegisterOwnerClientInput {
  fullName: string;
  shopName: string;
  phone?: string;
  email?: string;
  password: string;
}

export async function fetchCurrentSession(): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>('/api/v1/auth/me', { method: 'GET' });
}

export async function registerOwnerAccount(
  input: RegisterOwnerClientInput
): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>('/api/v1/auth/register', {
    method: 'POST',
    body: input,
  });
}

export async function loginAccount(input: {
  identifier: string;
  password: string;
}): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: input,
  });
}

export async function logoutAccount(): Promise<void> {
  await apiRequest<{ loggedOut: boolean }>('/api/v1/auth/logout', {
    method: 'POST',
  });
}

export async function requestAccountPasswordReset(
  identifier: string
): Promise<{ accepted: boolean; message: string }> {
  return apiRequest<{ accepted: boolean; message: string }>(
    '/api/v1/auth/password-reset/request',
    {
      method: 'POST',
      body: { identifier },
    }
  );
}

export async function confirmAccountPasswordReset(input: {
  identifier: string;
  recoveryCode: string;
  newPassword: string;
}): Promise<{
  resetCompleted: true;
  issuedRecoveryKey: string;
  recoveryCodeHint: string;
}> {
  return apiRequest('/api/v1/auth/password-reset/confirm', {
    method: 'POST',
    body: input,
  });
}

export async function rotateAccountRecoveryKey(
  currentPassword: string
): Promise<{ issuedRecoveryKey: string; recoveryCodeHint: string }> {
  return apiRequest('/api/v1/auth/recovery-code/rotate', {
    method: 'POST',
    body: { currentPassword },
  });
}
