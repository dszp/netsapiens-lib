/**
 * Portable NetSapiens API v2 WRITE client — the separate, explicitly-imported write surface the read-only
 * `NsClient` deliberately does not have (a consumer holds `NsClient` precisely to know it cannot write).
 * This realizes the lib's planned split: read and write are two classes; only this one mutates. Node-free
 * (fetch/URL/crypto only), so it runs unchanged in a Cloudflare Worker.
 *
 * Starts with the device methods the portal's Ringotel activation needs (create/get/delete), over a
 * generic post/put/delete core, and is meant to GROW into the full NS write surface (users, DIDs, …) —
 * porting the endpoint/body shapes from the onboarding tool's resource defs as they're needed.
 *
 * Like the onboarding client, POST/PUT inject `synchronous: 'yes'` so a create returns 200 + the created
 * resource inline (with server-generated fields — e.g. a device's `device-sip-registration-password`)
 * instead of a 202 with replication lag. Shares the read client's SSRF guard and `NsApiError`.
 */
import type { Rec } from './model.js';
import { NsApiError, assertBareServer, asArray } from './nsClient.js';

export interface NsWriteClientConfig {
  /** API host, e.g. "api.example.com". Base URL becomes https://{server}/ns-api/v2. */
  server: string;
  /** Bearer token (an API key with write scope). */
  token: string;
  /** Injectable for tests / non-global fetch. */
  fetchImpl?: typeof fetch;
}

const enc = encodeURIComponent;

export class NsWriteClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;

  constructor(cfg: NsWriteClientConfig) {
    this.#baseUrl = `https://${assertBareServer(cfg.server)}/ns-api/v2`;
    this.#token = cfg.token;
    this.#fetchImpl = cfg.fetchImpl ?? fetch;
  }

  // ── generic verbs (the growth surface) ──────────────────────────────────────
  get<T = unknown>(path: string, query?: Record<string, string | number>): Promise<T> {
    return this.#request<T>('GET', path, undefined, query);
  }
  /** POST with `synchronous:'yes'` injected → 200 + created resource inline. */
  post<T = unknown>(path: string, body: Rec): Promise<T> {
    return this.#request<T>('POST', path, { synchronous: 'yes', ...body });
  }
  /** PUT with `synchronous:'yes'` injected. */
  put<T = unknown>(path: string, body: Rec): Promise<T> {
    return this.#request<T>('PUT', path, { synchronous: 'yes', ...body });
  }
  delete<T = unknown>(path: string): Promise<T> {
    return this.#request<T>('DELETE', path);
  }

  // ── typed device helpers ────────────────────────────────────────────────────
  /** List a user's devices (normalized to an array). */
  getDevices(domain: string, user: string): Promise<Rec[]> {
    return this.get<unknown>(`/domains/${enc(domain)}/users/${enc(user)}/devices`).then(asArray);
  }
  /** Read one device (e.g. to fetch its `device-sip-registration-password`). */
  getDevice(domain: string, user: string, device: string): Promise<Rec> {
    return this.get<Rec>(`/domains/${enc(domain)}/users/${enc(user)}/devices/${enc(device)}`);
  }
  /**
   * Create a device (softphone when named `<ext><suffix>`, e.g. `100r`). NS auto-generates the SIP
   * password when unset; with `synchronous:'yes'` it comes back inline in the response. `extra` allows
   * optional fields (e.g. an emergency caller-id).
   */
  createDevice(domain: string, user: string, device: string, extra: Rec = {}): Promise<Rec> {
    return this.post<Rec>(`/domains/${enc(domain)}/users/${enc(user)}/devices`, { device, ...extra });
  }
  /** Delete a device. */
  deleteDevice(domain: string, user: string, device: string): Promise<Rec> {
    return this.delete<Rec>(`/domains/${enc(domain)}/users/${enc(user)}/devices/${enc(device)}`);
  }

  async #request<T>(method: string, path: string, body?: Rec, query?: Record<string, string | number>): Promise<T> {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));

    // Call via a local, NOT `this.#fetchImpl(...)`: invoking the global fetch as a method of this
    // instance throws "Illegal invocation" in workerd (the global fetch requires a global `this`).
    const doFetch = this.#fetchImpl;
    const res = await doFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* some endpoints return empty / plain bodies */
      }
    }
    if (!res.ok) {
      const detail = (typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed) : String(parsed)).slice(0, 500);
      const hint = res.status === 401 ? ' (token expired/invalid or domain out of scope)' : res.status === 403 ? ' (token lacks permission)' : '';
      throw new NsApiError(`${method} ${path} → ${res.status}${hint}: ${detail}`, res.status, path, parsed, method);
    }
    return parsed as T;
  }
}
