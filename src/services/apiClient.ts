export const SHOPBOOK_CLIENT_HEADER = 'X-ShopBook-Client';
export const SHOPBOOK_CLIENT_VALUE = 'web-v1';

export class ApiClientError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

let customFetchAdapter: FetchLike | null = null;

/**
 * Allows automated tests to attach an in-memory Fastify adapter or network fault injector
 * while browser code uses standard `globalThis.fetch` with relative `/api/v1/...` paths.
 */
export function setApiFetchAdapter(adapter: FetchLike | null): void {
  customFetchAdapter = adapter;
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    shopId?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    [SHOPBOOK_CLIENT_HEADER]: SHOPBOOK_CLIENT_VALUE,
  };

  if (options.shopId) {
    headers['X-Shop-Id'] = options.shopId;
  }

  let serializedBody: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    serializedBody = JSON.stringify(options.body);
  }

  const fetchImpl: FetchLike =
    customFetchAdapter ?? ((url, init) => globalThis.fetch(url, init));

  let response: Response;
  try {
    response = await fetchImpl(path, {
      method,
      headers,
      body: serializedBody,
      credentials: 'include',
      signal: options.signal,
    });
  } catch (err) {
    throw new ApiClientError(
      0,
      'NETWORK_OFFLINE',
      err instanceof Error && err.message
        ? `Network unavailable (${err.message}). Local shop records remain safely saved on this device.`
        : 'Cannot reach ShopBook server right now. Local shop records remain safely saved on this device.'
    );
  }

  let json: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    json = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const errObj =
      json && typeof json === 'object' && 'error' in json
        ? (json as { error?: { code?: string; message?: string } }).error
        : undefined;
    throw new ApiClientError(
      response.status,
      errObj?.code ?? `HTTP_${response.status}`,
      errObj?.message ?? `Request failed (${response.status}).`
    );
  }

  return json as T;
}
