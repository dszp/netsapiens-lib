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
 * POST/PUT inject `synchronous: 'yes'` **only on the operations that accept it** (see
 * {@link supportsSynchronous}), where it makes the API return 200 + the resulting resource inline —
 * with server-generated fields such as a device's `device-sip-registration-password` — instead of a
 * bare 202 acknowledgement. Everywhere else the flag is omitted, because sending it there is inert:
 * NetSapiens ignores it and still answers 202, which previously made this client look as though all
 * of its writes were confirmed when most were not. Shares the read client's SSRF guard and `NsApiError`.
 */
import type { Rec } from './model.js';
import { NsApiError, assertBareServer, asArray } from './nsClient.js';
import { ensureNsDevice, type EnsureNsDeviceOptions, type EnsureNsDeviceResult } from './nsDevice.js';
import { supportsSynchronous } from './nsSynchronous.js';

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
  /**
   * POST. On an operation that accepts it, `synchronous:'yes'` is injected → 200 + the created
   * resource inline; otherwise the flag is omitted and the API answers 202 Accepted.
   */
  post<T = unknown>(path: string, body: Rec): Promise<T> {
    return this.#request<T>('POST', path, this.#withSynchronous('POST', path, body));
  }
  /**
   * PUT. Same rule as {@link post} — and note most updates do NOT accept the flag, so their
   * response is a 202 acknowledgement with no resource body. Confirm those by reading back.
   */
  put<T = unknown>(path: string, body: Rec): Promise<T> {
    return this.#request<T>('PUT', path, this.#withSynchronous('PUT', path, body));
  }

  /** Add `synchronous:'yes'` only where the API declares support. An explicit caller value wins. */
  #withSynchronous(method: string, path: string, body: Rec): Rec {
    if (!supportsSynchronous(method, path)) return body;
    return { synchronous: 'yes', ...body };
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
  /**
   * Update a device in place.
   *
   * `PUT .../devices/{device}` does **not** accept `synchronous`, so this returns a 202
   * acknowledgement, not the updated device. Callers must not depend on the response echoing their
   * change back — {@link ensureNsDevice} falls back to the value it just sent for exactly this reason.
   *
   * The reason this exists rather than callers using `put()`: rotating
   * `device-sip-registration-password` must **not** be done by deleting and recreating the device, which
   * would discard everything else on it — emergency caller id, the provisioning MAC/model link, SRTP and
   * transport settings. A PUT changes the one field and preserves the rest.
   */
  updateDevice(domain: string, user: string, device: string, changes: Rec): Promise<Rec> {
    return this.put<Rec>(`/domains/${enc(domain)}/users/${enc(user)}/devices/${enc(device)}`, changes);
  }

  /** Delete a device. */
  deleteDevice(domain: string, user: string, device: string): Promise<Rec> {
    return this.delete<Rec>(`/domains/${enc(domain)}/users/${enc(user)}/devices/${enc(device)}`);
  }

  /**
   * Convenience wrapper over {@link ensureNsDevice} — ensure a device exists and return its SIP password,
   * optionally rotating it. See that function for the semantics, and for why rotation matters.
   *
   * Deliberately a **one-line delegation, not an implementation**. Every other method on this class is
   * exactly one HTTP request; this one is several with branching, so the logic lives in a standalone
   * function that composes over any writer (a consumer may have its own client) and that consumers can mock as
   * a plain 4-method object instead of stubbing a whole client. This method exists only so the capability
   * is discoverable from the client you already hold.
   */
  ensureDevice(opts: EnsureNsDeviceOptions): Promise<EnsureNsDeviceResult> {
    return ensureNsDevice(this, opts);
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
