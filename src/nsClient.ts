/**
 * Portable NetSapiens API read client — the seed of the eventual "NS API for Worker/Node"
 * library. Ported from an internal onboarding tool (its API client
 * NsClient + `src/backup/snapshot.ts` backupDomain), trimmed to the READ-ONLY routing subset the
 * resolver needs, and kept Node-free (fetch/URL only) so it runs in a Cloudflare Worker unchanged.
 *
 * `fetchDomainSnapshot()` assembles the same `Snapshot` shape the resolver already consumes, so a
 * live domain flows end-to-end: domain + token → Snapshot → resolveFlow → FlowGraph.
 *
 * This tool never writes to NetSapiens — only GET is exposed.
 */

import type { Rec, Snapshot } from './model.js';

export class NsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
    /** HTTP method — set by the write client; optional so read-client call sites stay unchanged. */
    public readonly method?: string,
  ) {
    super(message);
    this.name = 'NsApiError';
  }
}

export interface NsClientConfig {
  /** API host, e.g. "api.example.com". Base URL becomes https://{server}/ns-api/v2. */
  server: string;
  /** Bearer token (the portal user's `ns_t`, or an API key). */
  token: string;
  /** Injectable for tests / non-global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * NS API v2 client — READ-ONLY BY DESIGN (the central gate for this whole tool).
 *
 * The ONLY method is `get()`, which hardcodes `method: 'GET'`. There is deliberately no
 * post/put/delete/patch — the viewer must never mutate NetSapiens. Keep it that way: do not add a
 * mutating method here. Any write capability must be a separate, explicitly-reviewed client, not a
 * quiet addition to this one. This is the single choke point every NS call in the Worker flows through.
 */
/**
 * Reject a `server` that isn't a bare host or `host:port`. A caller that derives `server` from
 * request input (a multi-tenant tool) would otherwise let `api.example.com@evil.example` or
 * `evil.example#…` redirect the Bearer token to another origin — `new URL('https://'+server).host`
 * is what actually gets contacted, not the string. Comparing the parsed host back to the input
 * catches an embedded `@`, `/path`, `?query`, `#frag`, or scheme; credentials are refused explicitly.
 * Host comparison is case-insensitive (URL lowercases the host; NS hostnames are case-insensitive).
 */
export function assertBareServer(server: string): string {
  const s = String(server ?? '').trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(`https://${s}`);
  } catch {
    throw new Error(`Invalid NS server "${server}": expected a bare host or host:port`);
  }
  if (u.host !== s.toLowerCase() || u.username || u.password) {
    throw new Error(`Invalid NS server "${server}": expected a bare host or host:port (no scheme, path, query, fragment, or credentials)`);
  }
  return u.host;
}

export class NsClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;

  constructor(cfg: NsClientConfig) {
    this.#baseUrl = `https://${assertBareServer(cfg.server)}/ns-api/v2`;
    this.#token = cfg.token;
    this.#fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async get<T = unknown>(path: string, query?: Record<string, string | number>): Promise<T> {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));

    // Call via a local, NOT `this.#fetchImpl(...)`: invoking the global fetch as a method of this
    // instance throws "Illegal invocation" in workerd (the global fetch requires a global `this`).
    const doFetch = this.#fetchImpl;
    const res = await doFetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' },
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
      // Truncate BOTH branches to 500 chars: the object branch used to JSON.stringify the whole
      // upstream body unbounded, so a consumer that logs err.message could log an arbitrarily large
      // NS response. No credential is ever in it, but size alone is a footgun.
      const detail = (typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed) : String(parsed)).slice(0, 500);
      const hint = res.status === 401 ? ' (token expired/invalid or domain out of scope)' : res.status === 403 ? ' (token lacks permission)' : '';
      throw new NsApiError(`GET ${path} → ${res.status}${hint}: ${detail}`, res.status, path, parsed);
    }
    return parsed as T;
  }
}

/** Normalize a v2 response to an array of records (endpoints return an array or a bare object). */
export function asArray(res: unknown): Rec[] {
  if (Array.isArray(res)) return res as Rec[];
  if (res && typeof res === 'object') return [res as Rec];
  return [];
}

/** Map with bounded concurrency — keeps per-user/queue/AA fan-out from hammering the API. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
}

const enc = encodeURIComponent;

/** List domains the token can read (for the internal viewer's domain browser). `locked` is set only
 *  for domains flagged `is-domain-locked: yes` (config-locked in NetSapiens). */
export async function listDomains(client: NsClient): Promise<{ domain: string; description?: string; locked?: boolean }[]> {
  const recs = asArray(await client.get('/domains'));
  return recs
    .map((r) => ({
      domain: String(r.domain ?? ''),
      ...(r.description ? { description: String(r.description) } : {}),
      ...(r['is-domain-locked'] === 'yes' ? { locked: true } : {}),
    }))
    .filter((d) => d.domain);
}

export interface FetchSnapshotOptions {
  /** Fetch each AA's keypress menu (GET .../autoattendants/{prompt}). Default true. */
  includeAttendantMenus?: boolean;
  /** Also fetch the default-plan dialrules (rarely needed — classifyParam handles aliases). Default false. */
  includeDialrules?: boolean;
  /** Max concurrent per-item requests. Default 5. Mind Workers' subrequest cap on huge domains. */
  concurrency?: number;
  /**
   * Shallow: fetch only the top-level lists (domain, timeframes, users, callqueues, phonenumbers,
   * autoattendants) and skip the per-user/queue/AA fan-out. Enough for `listEntities()` (the entity
   * picker) at a fraction of the requests. Default false.
   */
  shallow?: boolean;
  /**
   * With `shallow`, also fetch answer rules for the DIDs' destination users (a handful of extra
   * reads) so `listEntities()` can flag time-of-day (TOD) DIDs. Default false.
   */
  includeDidDestRules?: boolean;
}

/**
 * Read a live domain into the `Snapshot` shape the resolver consumes. Routing subset only:
 * domain, timeframes, users, callqueues, phonenumbers, autoattendants, per-user answerrules,
 * per-queue agents, and (by default) per-AA menu detail.
 *
 * A per-item read that fails is treated as "absent" (empty) so one missing child never aborts the
 * whole flow — the resolver tolerates gaps. A failing top-level read (e.g. 401) DOES throw.
 */
export async function fetchDomainSnapshot(client: NsClient, domain: string, opts: FetchSnapshotOptions = {}): Promise<Snapshot> {
  const conc = opts.concurrency ?? 5;
  const base = `/domains/${enc(domain)}`;
  const soft = async (p: string): Promise<Rec[]> => {
    try {
      return asArray(await client.get(p));
    } catch (err) {
      if (err instanceof NsApiError && err.status === 404) return [];
      throw err;
    }
  };

  const domainRec = asArray(await client.get(base))[0] ?? { domain };
  const [timeframes, users, callqueues, phonenumbers, autoattendants] = await Promise.all([
    soft(`${base}/timeframes`),
    soft(`${base}/users`),
    soft(`${base}/callqueues`),
    soft(`${base}/phonenumbers`),
    soft(`${base}/autoattendants`),
  ]);

  // Shallow mode stops here — enough for listEntities() (the picker).
  if (opts.shallow) {
    let answerrulesByUser: Record<string, Rec[]> | undefined;
    if (opts.includeDidDestRules) {
      const dests = [...new Set(phonenumbers.map((p) => String(p['dial-rule-translation-destination-user'] ?? '')).filter(Boolean))];
      answerrulesByUser = {};
      await mapLimit(dests, conc, async (u) => {
        const rules = await soft(`${base}/users/${enc(u)}/answerrules`).catch(() => []);
        if (rules.length) answerrulesByUser![u] = rules;
      });
    }
    return { meta: { domain }, domain: domainRec, timeframes, users, callqueues, phonenumbers, autoattendants, ...(answerrulesByUser ? { answerrulesByUser } : {}) };
  }

  const answerrulesByUser: Record<string, Rec[]> = {};
  await mapLimit(users, conc, async (u) => {
    const ext = String(u.user ?? '');
    if (!ext) return;
    const rules = await soft(`${base}/users/${enc(ext)}/answerrules`).catch(() => []);
    if (rules.length) answerrulesByUser[ext] = rules;
  });

  const agentsByQueue: Record<string, Rec[]> = {};
  await mapLimit(callqueues, conc, async (q) => {
    const ext = String(q.callqueue ?? '');
    if (!ext) return;
    const ags = await soft(`${base}/callqueues/${enc(ext)}/agents`).catch(() => []);
    if (ags.length) agentsByQueue[ext] = ags;
  });

  // One list row per (user, prompt); an AA may have several (multi-timeframe). Collect ALL detail
  // records per user (array) so the resolver can flag multi-prompt deviations, not just last-wins.
  // Also fetch each AA's OWN dialplan dialrules ({domain}_{ext}) — the authoritative menu/default
  // routing the /autoattendants detail omits (no-key/star/option). See ARCHITECTURE.md → NetSapiens routing model.
  let attendantDetailsByUser: Record<string, Rec[]> | undefined;
  let attendantDialrulesByExt: Record<string, Rec[]> | undefined;
  if (opts.includeAttendantMenus ?? true) {
    const rows = autoattendants.map((aa) => ({ ext: String(aa.user ?? ''), prompt: String(aa['starting-prompt'] ?? '') })).filter((r) => r.ext && r.prompt);
    attendantDetailsByUser = {};
    for (const r of rows) attendantDetailsByUser[r.ext] ??= []; // pre-init (avoid concurrent-init race)
    await mapLimit(rows, conc, async (r) => {
      const detail = (await soft(`${base}/users/${enc(r.ext)}/autoattendants/${enc(r.prompt)}`).catch(() => []))[0];
      if (detail) attendantDetailsByUser![r.ext].push(detail);
    });
    attendantDialrulesByExt = {};
    await mapLimit([...new Set(rows.map((r) => r.ext))], conc, async (ext) => {
      const dr = await soft(`${base}/dialplans/${enc(`${domain}_${ext}`)}/dialrules`).catch(() => []);
      if (dr.length) attendantDialrulesByExt![ext] = dr;
    });
  }

  let dialrulesByPlan: Record<string, Rec[]> | undefined;
  if (opts.includeDialrules) {
    dialrulesByPlan = { [domain]: await soft(`${base}/dialplans/${enc(domain)}/dialrules`).catch(() => []) };
  }

  return {
    meta: { domain },
    domain: domainRec,
    timeframes,
    users,
    callqueues,
    phonenumbers,
    autoattendants,
    answerrulesByUser,
    agentsByQueue,
    ...(attendantDetailsByUser && Object.keys(attendantDetailsByUser).length ? { attendantDetailsByUser } : {}),
    ...(attendantDialrulesByExt && Object.keys(attendantDialrulesByExt).length ? { attendantDialrulesByExt } : {}),
    ...(dialrulesByPlan ? { dialrulesByPlan } : {}),
  };
}
