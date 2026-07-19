/**
 * NsAuthClient — the NetSapiens OAuth2 password-grant surface. Two jobs off one call:
 *   - verifyCredentials(user, pass): confirm an END USER's credentials (the SSO webhook's auth check).
 *   - passwordGrant(adminUser, adminPass): mint a reseller/admin access token to use as a write bearer,
 *     an alternative to a static API key.
 * Both use the deployment's "master key" (an OAuth application's client_id/client_secret). Node-free
 * (fetch/URLSearchParams). The token endpoint is form-encoded and returns JSON.
 *
 * Fail-closed contract: passwordGrant throws NsAuthError on ANY non-2xx. verifyCredentials treats a 4xx as
 * "bad credentials" ({ ok:false }) but RETHROWS a 5xx / network error, so a caller cannot mistake an
 * upstream outage for a failed login.
 */

import { assertBareServer } from './nsClient.js';

export class NsAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'NsAuthError';
  }
}

export interface NsTokenResponse {
  access_token?: string;
  /** The authenticated user's extension (NetSapiens returns this on the token body). */
  user?: string;
  domain?: string;
  scope?: string;
  [k: string]: unknown;
}

export interface NsAuthClientConfig {
  /** API host, e.g. "api.example.com" (bare — no scheme/path). Token endpoint = https://{server}/ns-api/oauth2/token/ */
  server: string;
  /** OAuth application client id (the "master key" id). */
  clientId: string;
  /** OAuth application client secret. */
  clientSecret: string;
  /** Injectable for tests / non-global fetch. */
  fetchImpl?: typeof fetch;
}

export class NsAuthClient {
  readonly #url: string;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetchImpl: typeof fetch;

  constructor(cfg: NsAuthClientConfig) {
    this.#url = `https://${assertBareServer(cfg.server)}/ns-api/oauth2/token/`;
    this.#clientId = cfg.clientId;
    this.#clientSecret = cfg.clientSecret;
    this.#fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async passwordGrant(username: string, password: string): Promise<NsTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      username,
      password,
      format: 'json',
    });
    // Call via a local, NOT this.#fetchImpl(...): the global fetch requires a global `this` in workerd.
    const doFetch = this.#fetchImpl;
    const res = await doFetch(this.#url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
    }
    if (!res.ok) {
      const detail = (typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed) : String(parsed)).slice(0, 300);
      throw new NsAuthError(`NS oauth2/token → ${res.status}: ${detail}`, res.status);
    }
    return (parsed && typeof parsed === 'object' ? parsed : {}) as NsTokenResponse;
  }

  /**
   * Confirm an end user's credentials via OAuth2 password-grant.
   *
   * Contract: `ok` is true IF AND ONLY IF the token response carried a non-empty `access_token`.
   * NetSapiens can return HTTP 200 with an empty/in-band-error body (no `access_token`) — that is
   * NOT a successful login, so a bare 2xx is not sufficient. A 4xx maps to `{ ok: false }`; a 5xx /
   * network error rethrows so a caller cannot mistake an upstream outage for a failed login.
   */
  async verifyCredentials(username: string, password: string): Promise<{ ok: boolean; token?: NsTokenResponse }> {
    try {
      const token = await this.passwordGrant(username, password);
      if (!token.access_token) return { ok: false };
      return { ok: true, token };
    } catch (e) {
      if (e instanceof NsAuthError && e.status >= 400 && e.status < 500) return { ok: false };
      throw e; // 5xx / network → fail closed upstream
    }
  }
}
