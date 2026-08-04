/**
 * NetSapiens API v2 **Event Subscriptions** — a separate client for the `/subscriptions` surface, plus a
 * pure reconciliation planner.
 *
 * This is its own class on purpose. `NsClient` is read-only by charter (a consumer holds one precisely to
 * know it cannot write), and `NsWriteClient`'s `delete()` sends no body — while
 * `DELETE /subscriptions/{id}` *requires* one (`subscription_id`, plus `domain` for scopes below Super
 * User). (A second reason applied until 0.1.7: `NsWriteClient` injected `synchronous: 'yes'` into *every*
 * POST/PUT, which no `/subscriptions` operation accepts. It now injects only where the API declares
 * support, so that objection is gone — the `delete()` body is what still makes the split necessary.)
 * Node-free (fetch/URL/crypto only), so it runs unchanged in a Cloudflare Worker.
 *
 * An event subscription tells NetSapiens to POST change events to a URL you own. Notable API properties
 * that shape this module:
 *
 * - **`id` is server-generated**, so a subscription cannot be tagged by the client. Ours are therefore
 *   identified by `post-url`, which makes the URL both the address *and* the label.
 * - **Filters are immutable.** `PUT` accepts `post-url` and `subscription-expires-datetime` but not
 *   `domain`/`user`/`reseller`, so a filter change means a new subscription.
 * - **Always send an explicit `expiresAt`.** Observed behaviour: an explicit expiry is stored verbatim
 *   *even when the request is authenticated with a one-hour OAuth access token* — the expiry is not
 *   clamped to the credential's lifetime. Omitting it yields a ~20-year expiry for an API key but only the
 *   token's expiry for a timed token, so relying on the default makes lifetime depend on how you
 *   authenticated. Renewal, when needed, is a `PUT`, never delete-and-recreate.
 * - ⚠️ **`subscription-geo-support` behaves as `no` when omitted**, despite the API describing the default
 *   as `yes`. Send it explicitly if you want geo-redundant delivery (you almost certainly do — otherwise
 *   delivery is pinned and stops when that node is down).
 * - ⚠️ **The domain-scoped routes (`/domains/{domain}/subscriptions`, API v45+) are not present on every
 *   cluster** — a v44 cluster answers `404 No Route Found` while the flat `/subscriptions` paths work.
 *   Prefer the flat methods and treat the domain-scoped ones as an opt-in optimization.
 * - **Datetimes are asymmetric.** Reads observably return ISO-8601 with an offset; the documented *write*
 *   format is `YYYY-MM-DD HH:MM:SS`. {@link parseNsDatetime} accepts both; {@link nsDatetime} emits the
 *   documented form.
 * - **`error-count` > 0 is normal on a healthy subscription** — a live example sat at 7 errors across 7195
 *   posts while `status` stayed `active`. Treat `status === 'error'` or a sustained error *rate* as the
 *   signal, and never reset the counters as routine maintenance: they are the only history the API keeps.
 */
import type { Rec } from './model.js';
import { NsApiError, assertBareServer, asArray } from './nsClient.js';

/** Event types a subscription can carry. One subscription carries exactly one model. */
export type SubscriptionModel =
  | 'agent'
  | 'auditlog'
  | 'auditlog_lite'
  | 'call'
  | 'call_origid'
  | 'cdr'
  | 'message'
  | 'messagesession'
  | 'subscriber'
  | 'presence'
  | 'voicemail';

/** Every valid `model` value, for validating configuration before it reaches the API. */
export const SUBSCRIPTION_MODELS: readonly SubscriptionModel[] = [
  'agent',
  'auditlog',
  'auditlog_lite',
  'call',
  'call_origid',
  'cdr',
  'message',
  'messagesession',
  'subscriber',
  'presence',
  'voicemail',
] as const;

/** Narrowing guard for a configured model string. */
export function isSubscriptionModel(v: unknown): v is SubscriptionModel {
  return typeof v === 'string' && (SUBSCRIPTION_MODELS as readonly string[]).includes(v);
}

/** Server-reported delivery health. `pending` until the first successful post. */
export type SubscriptionStatus = 'pending' | 'active' | 'error';

/**
 * A subscription, with the API's hyphenated wire keys mapped to camelCase. Datetimes are kept as the
 * **raw strings** the API returned (parse with {@link parseNsDatetime} when you need a `Date`), and `raw`
 * carries the untouched record so a caller never loses a field this type hasn't modelled.
 */
export interface Subscription {
  id: string;
  model?: string;
  postUrl?: string;
  geoSupport?: string;
  userScope?: string;
  reseller?: string;
  domain?: string;
  user?: string;
  /** Raw `subscription-creation-datetime`. */
  createdAt?: string;
  /** Raw `subscription-expires-datetime`. */
  expiresAt?: string;
  preferredServer?: string;
  /** Read-only: the node currently delivering. Changes on failover. */
  currentActiveServer?: string;
  status?: string;
  errorCount?: number;
  postsCount?: number;
  /** The untouched API record. */
  raw: Rec;
}

/** Fields accepted when creating. `domain`/`user`/`reseller` are the (immutable) event filters. */
export interface CreateSubscriptionInput {
  model: SubscriptionModel;
  /** Absolute https URL NetSapiens will POST to. */
  postUrl: string;
  /** Restrict to one domain. `'*'` means all domains and requires Super User scope. */
  domain?: string;
  /** Restrict to one user/extension. Defaults to all. */
  user?: string;
  /** Restrict to one reseller. `'*'` requires Super User scope. */
  reseller?: string;
  /**
   * Geo-redundant delivery across nodes. ⚠️ Behaves as `'no'` when omitted, despite the API documenting
   * `'yes'` as the default — send `'yes'` explicitly unless you deliberately want delivery pinned.
   */
  geoSupport?: 'yes' | 'no';
  /**
   * Explicit expiry, and you should always set one. It is honoured verbatim even when the request is
   * authenticated with a short-lived OAuth token. Omitting it makes the lifetime depend on the credential
   * (API key ⇒ ~20 years; timed token ⇒ that token's expiry).
   */
  expiresAt?: Date | string;
  /** Preferred delivering node. A preference, not a pin — other nodes deliver during instability. */
  preferredServer?: string;
}

/** Fields `PUT` accepts. The event filters are deliberately absent — they cannot be changed. */
export interface UpdateSubscriptionInput {
  model?: SubscriptionModel;
  postUrl?: string;
  geoSupport?: 'yes' | 'no';
  expiresAt?: Date | string;
  preferredServer?: string;
  /** Only `0` is accepted — a reset. Prefer leaving counters alone; they are the only history kept. */
  errorCount?: 0;
  /** Only `0` is accepted — a reset. */
  postsCount?: 0;
}

const enc = encodeURIComponent;
const two = (n: number) => String(n).padStart(2, '0');

/**
 * Format a `Date` as the documented write format `YYYY-MM-DD HH:MM:SS`, **in UTC**.
 *
 * The API documents no timezone for this field. Emitting UTC is the only self-consistent choice, and it
 * round-trips with {@link parseNsDatetime}, which also reads a bare timestamp as UTC.
 */
export function nsDatetime(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}` +
    ` ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`
  );
}

/**
 * Parse either datetime shape the API uses: the documented `YYYY-MM-DD HH:MM:SS` (read as **UTC**) or the
 * ISO-8601-with-offset form that reads actually return. Returns `undefined` rather than an Invalid Date so
 * callers fail closed on a value they can't interpret.
 */
export function parseNsDatetime(s: string | undefined | null): Date | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  if (!t) return undefined;
  // Bare "YYYY-MM-DD HH:MM:SS" (optionally with fractional seconds) carries no zone → treat as UTC.
  const bare = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(t);
  if (bare) {
    const ms = Date.UTC(
      Number(bare[1]),
      Number(bare[2]) - 1,
      Number(bare[3]),
      Number(bare[4]),
      Number(bare[5]),
      Number(bare[6] ?? 0),
    );
    return Number.isNaN(ms) ? undefined : new Date(ms);
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Map one API record to {@link Subscription}. Tolerant: an unmodelled or missing field is simply absent. */
export function subscriptionFromWire(rec: Rec): Subscription {
  return {
    id: String(rec['id'] ?? ''),
    ...(str(rec['model']) ? { model: str(rec['model'])! } : {}),
    ...(str(rec['post-url']) ? { postUrl: str(rec['post-url'])! } : {}),
    ...(str(rec['subscription-geo-support']) ? { geoSupport: str(rec['subscription-geo-support'])! } : {}),
    ...(str(rec['user-scope']) ? { userScope: str(rec['user-scope'])! } : {}),
    ...(str(rec['reseller']) ? { reseller: str(rec['reseller'])! } : {}),
    ...(str(rec['domain']) ? { domain: str(rec['domain'])! } : {}),
    ...(str(rec['user']) ? { user: str(rec['user'])! } : {}),
    ...(str(rec['subscription-creation-datetime']) ? { createdAt: str(rec['subscription-creation-datetime'])! } : {}),
    ...(str(rec['subscription-expires-datetime']) ? { expiresAt: str(rec['subscription-expires-datetime'])! } : {}),
    ...(str(rec['preferred-server']) ? { preferredServer: str(rec['preferred-server'])! } : {}),
    ...(str(rec['current-active-server']) ? { currentActiveServer: str(rec['current-active-server'])! } : {}),
    ...(str(rec['status']) ? { status: str(rec['status'])! } : {}),
    ...(num(rec['error-count']) !== undefined ? { errorCount: num(rec['error-count'])! } : {}),
    ...(num(rec['posts-count']) !== undefined ? { postsCount: num(rec['posts-count'])! } : {}),
    raw: rec,
  };
}

function expiryToWire(v: Date | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : nsDatetime(v);
}

/** Map {@link CreateSubscriptionInput} to the hyphenated request body. */
export function createInputToWire(input: CreateSubscriptionInput): Rec {
  const body: Rec = { model: input.model, 'post-url': input.postUrl };
  if (input.domain !== undefined) body['domain'] = input.domain;
  if (input.user !== undefined) body['user'] = input.user;
  if (input.reseller !== undefined) body['reseller'] = input.reseller;
  if (input.geoSupport !== undefined) body['subscription-geo-support'] = input.geoSupport;
  const exp = expiryToWire(input.expiresAt);
  if (exp !== undefined) body['subscription-expires-datetime'] = exp;
  if (input.preferredServer !== undefined) body['preferred-server'] = input.preferredServer;
  return body;
}

/** Map {@link UpdateSubscriptionInput} to the hyphenated request body. */
export function updateInputToWire(changes: UpdateSubscriptionInput): Rec {
  const body: Rec = {};
  if (changes.model !== undefined) body['model'] = changes.model;
  if (changes.postUrl !== undefined) body['post-url'] = changes.postUrl;
  if (changes.geoSupport !== undefined) body['subscription-geo-support'] = changes.geoSupport;
  const exp = expiryToWire(changes.expiresAt);
  if (exp !== undefined) body['subscription-expires-datetime'] = exp;
  if (changes.preferredServer !== undefined) body['preferred-server'] = changes.preferredServer;
  if (changes.errorCount !== undefined) body['error-count'] = changes.errorCount;
  if (changes.postsCount !== undefined) body['posts-count'] = changes.postsCount;
  return body;
}

export interface NsSubscriptionsClientConfig {
  /** API host, e.g. `"api.example.com"`. Base URL becomes `https://{server}/ns-api/v2`. */
  server: string;
  /** Bearer token — an API key, or an OAuth access token, with scope to manage subscriptions. */
  token: string;
  /** Injectable for tests / non-global fetch. */
  fetchImpl?: typeof fetch;
  /** Page size for list calls. Default 500. */
  pageSize?: number;
}

/** Thrown by {@link NsSubscriptionsClient.create} on the API's 409 "already exists" response. */
export class NsSubscriptionConflictError extends NsApiError {
  constructor(message: string, path: string, body: unknown) {
    super(message, 409, path, body, 'POST');
    this.name = 'NsSubscriptionConflictError';
  }
}

/**
 * Read/write client for `/subscriptions`.
 *
 * ```ts
 * const subs = new NsSubscriptionsClient({ server: 'api.example.com', token: key });
 * const mine = (await subs.list()).filter((s) => s.postUrl?.startsWith('https://hooks.example.com/'));
 * ```
 */
export class NsSubscriptionsClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;
  readonly #pageSize: number;

  constructor(cfg: NsSubscriptionsClientConfig) {
    this.#baseUrl = `https://${assertBareServer(cfg.server)}/ns-api/v2`;
    this.#token = cfg.token;
    this.#fetchImpl = cfg.fetchImpl ?? fetch;
    this.#pageSize = cfg.pageSize && cfg.pageSize > 0 ? cfg.pageSize : 500;
  }

  /**
   * Every subscription the credential can see, paged to completion.
   *
   * Paging matters: with no local registry this list *is* the source of truth, so a partial read would
   * make a reconciler create duplicates or skip renewals. The loop is defensive in both directions — it
   * stops on a short page, and also if a server that ignores the paging parameters returns the same
   * records again.
   */
  list(): Promise<Subscription[]> {
    return this.#listPaged('/subscriptions');
  }

  /** Subscriptions filtered to one domain. ⚠️ Requires API v45+; a v44 cluster returns 404. */
  listForDomain(domain: string): Promise<Subscription[]> {
    return this.#listPaged(`/domains/${enc(domain)}/subscriptions`);
  }

  /** Read one subscription by id. */
  async get(id: string): Promise<Subscription> {
    const rec = await this.#request<Rec>('GET', `/subscriptions/${enc(id)}`);
    return subscriptionFromWire(rec);
  }

  /**
   * Create a subscription. Throws {@link NsSubscriptionConflictError} on 409, which the API returns when a
   * subscription with a matching set of parameters already exists — usually meaning the desired state is
   * already in place.
   */
  create(input: CreateSubscriptionInput): Promise<Subscription> {
    return this.#create('/subscriptions', createInputToWire(input));
  }

  /** Create against the domain-scoped path. ⚠️ Requires API v45+; a v44 cluster returns 404. */
  createForDomain(domain: string, input: CreateSubscriptionInput): Promise<Subscription> {
    return this.#create(`/domains/${enc(domain)}/subscriptions`, createInputToWire(input));
  }

  /**
   * Update a subscription — this is how renewal works (a new `subscription-expires-datetime`) and how a
   * callback URL is rotated (`post-url`). The event filters cannot be changed.
   */
  update(id: string, changes: UpdateSubscriptionInput): Promise<unknown> {
    return this.#request('PUT', `/subscriptions/${enc(id)}`, updateInputToWire(changes));
  }

  /** Update against the domain-scoped path. ⚠️ Requires API v45+; a v44 cluster returns 404. */
  updateForDomain(domain: string, id: string, changes: UpdateSubscriptionInput): Promise<unknown> {
    return this.#request('PUT', `/domains/${enc(domain)}/subscriptions/${enc(id)}`, updateInputToWire(changes));
  }

  /**
   * Delete a subscription.
   *
   * Note the body: this endpoint takes `subscription_id` (and `domain`, required for scopes below Super
   * User) *in addition to* the path id. That is why this client exists rather than reusing a generic write
   * client whose `delete()` sends no body.
   */
  remove(id: string, opts: { domain?: string } = {}): Promise<unknown> {
    const body: Rec = { subscription_id: id };
    if (opts.domain !== undefined) body['domain'] = opts.domain;
    return this.#request('DELETE', `/subscriptions/${enc(id)}`, body);
  }

  async #create(path: string, body: Rec): Promise<Subscription> {
    try {
      const rec = await this.#request<Rec>('POST', path, body);
      return subscriptionFromWire(rec);
    } catch (e) {
      if (e instanceof NsApiError && e.status === 409) {
        throw new NsSubscriptionConflictError(e.message, path, e.body);
      }
      throw e;
    }
  }

  async #listPaged(path: string): Promise<Subscription[]> {
    const out: Subscription[] = [];
    const seen = new Set<string>();
    const limit = this.#pageSize;
    for (let start = 0, guard = 0; guard < 200; guard++, start += limit) {
      const page = asArray(await this.#request<unknown>('GET', path, undefined, { limit, start }));
      if (page.length === 0) break;
      let added = 0;
      for (const rec of page) {
        const sub = subscriptionFromWire(rec);
        if (!sub.id || seen.has(sub.id)) continue;
        seen.add(sub.id);
        out.push(sub);
        added++;
      }
      // Short page ⇒ done. No new ids ⇒ the server ignored our paging parameters; stop rather than loop.
      if (page.length < limit || added === 0) break;
    }
    return out;
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
      const hint =
        res.status === 401
          ? ' (token expired/invalid or domain out of scope)'
          : res.status === 403
            ? ' (token lacks permission)'
            : res.status === 409
              ? ' (a subscription with matching parameters already exists)'
              : '';
      throw new NsApiError(`${method} ${path} → ${res.status}${hint}: ${detail}`, res.status, path, parsed, method);
    }
    return parsed as T;
  }
}

// ── the pure planner ─────────────────────────────────────────────────────────────────────────────────

/** One subscription we want to exist. */
export interface DesiredSubscription {
  domain: string;
  model: SubscriptionModel;
  /** The exact callback URL this (domain, model) should post to. */
  postUrl: string;
}

/** An action the caller should execute. Every variant carries a human-readable `reason` for logging. */
export type SubscriptionAction =
  | { kind: 'create'; domain: string; model: SubscriptionModel; postUrl: string; expiresAt: string; reason: string }
  | { kind: 'renew'; id: string; domain: string; expiresAt: string; reason: string }
  | { kind: 'repair-url'; id: string; domain: string; postUrl: string; reason: string }
  | { kind: 'delete'; id: string; domain: string; reason: string }
  | { kind: 'report'; id: string; domain: string; reason: string; status?: string; errorCount?: number; postsCount?: number }
  | { kind: 'noop'; id: string; domain: string; reason: string };

export interface PlanSubscriptionsOptions {
  /**
   * Only subscriptions whose `postUrl` starts with this prefix are considered ours. Everything else is
   * left strictly alone — other integrations legitimately subscribe to the same domains.
   */
  ownedPrefix: string;
  /** Renew when the remaining lifetime is below this. */
  renewHorizonSeconds: number;
  /** Lifetime to request on create and renew. */
  targetLifetimeSeconds: number;
  /** Report when `errorCount / postsCount` exceeds this. Default 0.5. */
  errorRateThreshold?: number;
  /** Don't judge an error rate below this many posts — small samples are noise. Default 25. */
  minPostsForRate?: number;
}

function pickCanonical(subs: Subscription[]): Subscription {
  // Prefer an active one, then the most recently created; mirrors how the rest of the stack breaks ties.
  const score = (s: Subscription) => (s.status === 'active' ? 2 : s.status === 'pending' ? 1 : 0);
  return [...subs].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    const at = parseNsDatetime(a.createdAt)?.getTime() ?? 0;
    const bt = parseNsDatetime(b.createdAt)?.getTime() ?? 0;
    return bt - at;
  })[0] as Subscription;
}

/**
 * Decide what to do, given what we want and what the API currently reports. Pure: no I/O, no clock, no
 * configuration beyond {@link PlanSubscriptionsOptions} — so the whole decision surface is unit-testable
 * and shareable by any consumer that manages its own subscriptions.
 *
 * Deliberate behaviours worth knowing:
 * - Subscriptions outside `ownedPrefix` are **never** modified. If one collides with a desired
 *   (domain, model) it is *reported*, because two subscriptions on one domain double-deliver.
 * - `errorCount > 0` alone is **not** a fault — see this module's header.
 * - An already-expired subscription yields `renew`, not `delete`+`create`; the caller should fall back to
 *   `create` only if the `PUT` reports the subscription is gone.
 */
export function planSubscriptions(
  desired: DesiredSubscription[],
  actual: Subscription[],
  nowMs: number,
  opts: PlanSubscriptionsOptions,
): SubscriptionAction[] {
  const rateThreshold = opts.errorRateThreshold ?? 0.5;
  const minPosts = opts.minPostsForRate ?? 25;
  const targetExpiry = nsDatetime(new Date(nowMs + opts.targetLifetimeSeconds * 1000));

  const isOurs = (s: Subscription) => typeof s.postUrl === 'string' && s.postUrl.startsWith(opts.ownedPrefix);
  const ours = actual.filter(isOurs);
  const foreign = actual.filter((s) => !isOurs(s));
  const key = (domain: string, model: string) => `${domain.toLowerCase()}\u0000${model}`;

  const actions: SubscriptionAction[] = [];
  const claimed = new Set<string>();

  for (const want of desired) {
    const k = key(want.domain, want.model);
    claimed.add(k);

    const matches = ours.filter((s) => key(s.domain ?? '', s.model ?? '') === k);

    for (const f of foreign) {
      if (key(f.domain ?? '', f.model ?? '') === k) {
        actions.push({
          kind: 'report',
          id: f.id,
          domain: want.domain,
          reason: 'another integration already subscribes to this domain+model; events will be delivered twice',
          ...(f.status !== undefined ? { status: f.status } : {}),
        });
      }
    }

    if (matches.length === 0) {
      actions.push({
        kind: 'create',
        domain: want.domain,
        model: want.model,
        postUrl: want.postUrl,
        expiresAt: targetExpiry,
        reason: 'no subscription exists for this domain+model',
      });
      continue;
    }

    const canonical = pickCanonical(matches);
    for (const extra of matches) {
      if (extra.id !== canonical.id) {
        actions.push({
          kind: 'delete',
          id: extra.id,
          domain: extra.domain ?? want.domain,
          reason: 'duplicate of our own subscription for this domain+model',
        });
      }
    }

    // Health is reported independently of whether the record also needs a url/expiry change.
    const errs = canonical.errorCount ?? 0;
    const posts = canonical.postsCount ?? 0;
    if (canonical.status === 'error') {
      actions.push({
        kind: 'report',
        id: canonical.id,
        domain: canonical.domain ?? want.domain,
        reason: 'delivery is failing (status=error)',
        ...(canonical.status !== undefined ? { status: canonical.status } : {}),
        errorCount: errs,
        postsCount: posts,
      });
    } else if (posts >= minPosts && errs / posts > rateThreshold) {
      actions.push({
        kind: 'report',
        id: canonical.id,
        domain: canonical.domain ?? want.domain,
        reason: `sustained delivery error rate ${errs}/${posts}`,
        ...(canonical.status !== undefined ? { status: canonical.status } : {}),
        errorCount: errs,
        postsCount: posts,
      });
    }

    if (canonical.postUrl !== want.postUrl) {
      actions.push({
        kind: 'repair-url',
        id: canonical.id,
        domain: canonical.domain ?? want.domain,
        postUrl: want.postUrl,
        reason: 'callback URL differs from the configured one (deploy moved, or secret rotated)',
      });
      continue;
    }

    const expiry = parseNsDatetime(canonical.expiresAt);
    if (!expiry) {
      actions.push({
        kind: 'renew',
        id: canonical.id,
        domain: canonical.domain ?? want.domain,
        expiresAt: targetExpiry,
        reason: 'expiry missing or unparseable',
      });
      continue;
    }
    const remainingSeconds = (expiry.getTime() - nowMs) / 1000;
    if (remainingSeconds <= 0) {
      actions.push({
        kind: 'renew',
        id: canonical.id,
        domain: canonical.domain ?? want.domain,
        expiresAt: targetExpiry,
        reason: 'already expired',
      });
    } else if (remainingSeconds < opts.renewHorizonSeconds) {
      actions.push({
        kind: 'renew',
        id: canonical.id,
        domain: canonical.domain ?? want.domain,
        expiresAt: targetExpiry,
        reason: `expires in ${Math.floor(remainingSeconds)}s, inside the renewal horizon`,
      });
    } else {
      actions.push({
        kind: 'noop',
        id: canonical.id,
        domain: canonical.domain ?? want.domain,
        reason: 'present, correct, and not near expiry',
      });
    }
  }

  // Ours, but no longer wanted.
  for (const s of ours) {
    const k = key(s.domain ?? '', s.model ?? '');
    if (!claimed.has(k)) {
      actions.push({
        kind: 'delete',
        id: s.id,
        domain: s.domain ?? '',
        reason: 'ours, but this domain+model is no longer configured',
      });
    }
  }

  return actions;
}
