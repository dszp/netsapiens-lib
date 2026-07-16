/**
 * NetSapiens `ns_t` JWT validation — runtime-portable (Cloudflare Worker + Node 18+).
 *
 * Ported from n8n-nodes-netsapiens (nodes/NetSapiens/NetSapiens.node.ts), which exposes two
 * operations we mirror here:
 *   - Validate JWT Format  → local base64url-decode + `exp` check, NO server contact, NO
 *     signature verification (low-security; matches the node exactly).
 *   - Validate JWT (live)  → GET {server}/ns-api/v2/jwt with `Authorization: Bearer <token>`;
 *     HTTP 401/403 ⇒ rejected. Authoritative, but a server roundtrip.
 *
 * Design constraint (David): the live path must NOT overload the NS API. So `verify()` gates on
 * the cheap local check first, then serves a *cached* live verdict keyed by a hash of the token,
 * with a TTL capped by the token's own `exp`. A bad or expired token never reaches the server.
 *
 * Uses only Web-standard globals (atob, TextDecoder, crypto.subtle, fetch) — no Node Buffer — so
 * the same file runs in a Worker and in the ns-onboard CLI.
 */

export interface JwtContext {
  /** The token's domain (from claims). Scopes downstream NS reads. When masking, this is the
   *  MASKED user's domain — the token is NS-scoped to it, not the operator's. */
  domain?: string;
  /** The token's user / extension (the masked user, when masking). */
  user?: string;
  /** user_scope / scope claim if present (Reseller / Office Manager / Basic User / …). When masking
   *  this is the MASKED user's scope, NOT the operator's — so don't infer "a reseller drives this"
   *  from scope alone; consult `maskChain`. */
  scope?: string;
  /** sub claim (typically user@domain — the effective/masked identity). */
  sub?: string;
  /** `mask_chain` claim: absent/null ⇒ NOT masking; `"user@domain"` ⇒ the REAL operator behind the
   *  mask (e.g. the reseller impersonating a domain user). The masking flag + operator identity. */
  maskChain?: string;
  /** user_email claim. */
  email?: string;
  /** displayName claim. */
  displayName?: string;
  /** territory claim. */
  territory?: string;
}

export interface JwtVerdict extends JwtContext {
  /** Structurally a JWT (3 segments, decodable payload). */
  validFormat: boolean;
  /** `exp` claim exists and is in the future. */
  unexpired: boolean;
  /** Result of the live server check, when performed. */
  live: 'valid' | 'invalid' | 'skipped' | 'error';
  /** Local HS256 signature check: 'valid'/'invalid' when a signingSecret is configured, else
   *  'unverified' (no local key — the live `/jwt` check is the signature authority). */
  signature?: 'valid' | 'invalid' | 'unverified';
  /** Overall gate: safe to proceed. */
  ok: boolean;
  expiresAt?: string;
  expiresInSeconds?: number;
  reason?: string;
  statusCode?: number;
  checkedAt: string;
  fromCache?: boolean;
  /** Full decoded payload (local decode). */
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Local decode (base64url) — Buffer-free
// ---------------------------------------------------------------------------

/** Decode a base64url string to UTF-8 without Node Buffer. */
function base64urlToUtf8(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Strip a leading "Bearer " and whitespace. */
export function normalizeToken(raw: string): string {
  return String(raw ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim();
}

/** base64url → bytes (no Node Buffer). Explicit `new Uint8Array(len)` so it's ArrayBuffer-backed
 *  (a plain BufferSource for crypto.subtle), not `Uint8Array<ArrayBufferLike>`. */
function base64urlToBytes(b64url: string) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length); // inferred Uint8Array<ArrayBuffer> — a plain BufferSource
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Assert the ns_t audience (and, by default, issuer). `aud` defaults to "ns" — that value is fixed by
 * the NetSapiens platform, true for every deployment — and is ALWAYS checked.
 *
 * `iss` is your Manager Portal host, which is deployment-specific, so it has **no default**: you must
 * either pass `iss` or explicitly opt out with `validateIss: false`. Omitting both fails closed rather
 * than silently skipping the check. (Earlier versions defaulted to one specific portal host, which
 * quietly bound every consumer to someone else's deployment — a bug, not a convenience.)
 *
 * `iss` accepts a LIST, mirroring `aud`: several portal hostnames can front the same backend (a
 * white-labelled host and the vendor's unbranded one), and a token minted by either is equally valid.
 * Matching is an **exact, case-sensitive** string compare against an explicit list — no wildcards, no
 * suffix matching. `["manage.example.com", "manage.vendor.example"]` is allowed; `"*.vendor.example"`
 * is not, and would be treated as a literal hostname that never matches.
 *
 * Pure claim comparison — no key needed, no network.
 */
export interface ClaimExpectations {
  /** Required audience — default "ns". Token `aud` must equal (or, if array, include) one of these. */
  aud?: string | string[];
  /** Required issuer(s) — YOUR portal host(s), e.g. "manage.example.com" or
   *  ["manage.example.com", "manage.vendor.example"]. Token `iss` must EXACTLY equal one of them.
   *  No default: required unless `validateIss: false`. */
  iss?: string | string[];
  /** Set false to SKIP issuer validation (e.g. accepting tokens across portal domains). Default true,
   *  which makes `iss` mandatory. */
  validateIss?: boolean;
}
export function assertClaims(payload: Record<string, unknown>, exp: ClaimExpectations = {}): { ok: boolean; reason?: string } {
  const wantAud = exp.aud ?? 'ns';
  const wanted = Array.isArray(wantAud) ? wantAud : [wantAud];
  const rawAud = payload.aud;
  const got = Array.isArray(rawAud) ? rawAud.map(String) : rawAud != null ? [String(rawAud)] : [];
  if (!got.some((a) => wanted.includes(a))) {
    return { ok: false, reason: `aud mismatch (want ${wanted.join('|')}, got ${got.join('|') || '∅'})` };
  }
  if (exp.validateIss !== false) {
    // Accept one issuer or several (same backend behind more than one portal hostname). Exact match
    // only — a wildcard here would let any host under a suffix mint tokens we accept.
    const rawIss = exp.iss;
    const wantedIss = (Array.isArray(rawIss) ? rawIss : rawIss != null ? [rawIss] : []).map((i) => String(i).trim()).filter(Boolean);
    // No default: an issuer default would be someone's specific portal. Fail closed and say how to fix.
    if (!wantedIss.length) {
      return { ok: false, reason: 'iss expectation missing — pass `iss` (your portal host, e.g. "manage.example.com", or a list of them) or set `validateIss: false` to opt out' };
    }
    const gotIss = String(payload.iss ?? '');
    if (!wantedIss.includes(gotIss)) {
      return { ok: false, reason: `iss mismatch (want ${wantedIss.join('|')}, got ${gotIss || '∅'})` };
    }
  }
  return { ok: true };
}

/**
 * Verify an ns_t's HS256 signature locally with the shared secret. ns_t is HS256 (symmetric), signed
 * by the NetSapiens core — so this needs that HMAC secret (there is no public JWKS). Returns false for
 * a wrong/absent secret, tampered token, or any header alg other than HS256 (blocks alg:none / alg
 * confusion). Async (crypto.subtle HMAC). When you don't hold the secret, leave it unset and rely on
 * the live `/jwt` roundtrip as the (server-side) signature authority.
 */
export async function verifyHs256Signature(token: string, secret: string): Promise<boolean> {
  const parts = normalizeToken(token).split('.');
  if (parts.length !== 3 || !secret) return false;
  try {
    const header = JSON.parse(base64urlToUtf8(parts[0]!)) as { alg?: string };
    if (header.alg !== 'HS256') return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, base64urlToBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}

/** exp/nbf claims may be number or numeric string (matches the node's toEpochSeconds). */
function toEpochSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const n = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Pull the routing-relevant context out of NS claims (tolerant of naming variants). */
export function extractContext(payload: Record<string, unknown>): JwtContext {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = payload[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  const sub = pick('sub', 'username', 'user_name');
  let domain = pick('domain', 'nsDomain', 'territory_domain');
  let user = pick('user', 'uid', 'extension');
  // sub is often user@domain — derive the halves if the explicit claims are absent.
  if (sub && sub.includes('@')) {
    const [u, d] = sub.split('@');
    user = user ?? u;
    domain = domain ?? d;
  }
  return {
    domain,
    user,
    scope: pick('user_scope', 'scope', 'role'),
    sub,
    maskChain: pick('mask_chain', 'maskChain'),
    email: pick('user_email', 'email'),
    displayName: pick('displayName', 'display_name', 'name'),
    territory: pick('territory'),
  };
}

export interface FormatResult {
  validFormat: boolean;
  unexpired: boolean;
  expiresAt?: string;
  expiresInSeconds?: number;
  reason?: string;
  payload?: Record<string, unknown>;
  context: JwtContext;
}

/**
 * Local format + expiry check. No network, no signature verification.
 * `nowMs` is injectable for testing.
 */
export function validateJwtFormat(token: string, nowMs: number = Date.now()): FormatResult {
  const t = normalizeToken(token);
  if (!t) return { validFormat: false, unexpired: false, reason: 'Empty token', context: {} };

  const parts = t.split('.');
  if (parts.length !== 3) {
    return { validFormat: false, unexpired: false, reason: `Expected 3 JWT segments, got ${parts.length}`, context: {} };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64urlToUtf8(parts[1]!)) as Record<string, unknown>;
  } catch {
    return { validFormat: false, unexpired: false, reason: 'Failed to decode JWT payload (invalid base64url or JSON)', context: {} };
  }

  const expSeconds = toEpochSeconds(payload.exp);
  const nowSeconds = Math.trunc(nowMs / 1000);
  const context = extractContext(payload);

  if (expSeconds === undefined) {
    return { validFormat: true, unexpired: false, reason: 'Missing or invalid exp claim', payload, context };
  }
  const expiresInSeconds = expSeconds - nowSeconds;
  return {
    validFormat: true,
    unexpired: expiresInSeconds > 0,
    expiresAt: new Date(expSeconds * 1000).toISOString(),
    expiresInSeconds,
    ...(expiresInSeconds <= 0 ? { reason: 'Token exp is in the past' } : {}),
    payload,
    context,
  };
}

// ---------------------------------------------------------------------------
// Live check + cache-aware verify
// ---------------------------------------------------------------------------

/** Pluggable verdict cache (back with Workers Cache API / KV / DO / memory). */
export interface VerdictCache {
  get(key: string): Promise<JwtVerdict | undefined>;
  /** ttlSeconds is a hint; the store may evict earlier. */
  set(key: string, verdict: JwtVerdict, ttlSeconds: number): Promise<void>;
}

/** Simple in-isolate cache for dev / a single Worker isolate (not shared across isolates). */
export class MemoryVerdictCache implements VerdictCache {
  private store = new Map<string, { verdict: JwtVerdict; expiresAtMs: number }>();
  async get(key: string): Promise<JwtVerdict | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAtMs <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.verdict;
  }
  async set(key: string, verdict: JwtVerdict, ttlSeconds: number): Promise<void> {
    this.store.set(key, { verdict, expiresAtMs: Date.now() + ttlSeconds * 1000 });
  }
}

/** SHA-256 hex of the token — cache key that never stores the raw token. */
export async function tokenKey(token: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeToken(token));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface VerifyOptions {
  /** NS API host, e.g. "api.example.com". */
  server: string;
  /** 'format' = local only (no roundtrip). 'live' = local gate + cached server check. */
  mode?: 'format' | 'live';
  cache?: VerdictCache;
  /** Max seconds to trust a cached live verdict (also capped by the token's exp). Default 60. */
  maxLiveTtlSeconds?: number;
  /** How long to cache a negative live verdict. Default 30. */
  negativeTtlSeconds?: number;
  /** Abort the live `/jwt` fetch after this many ms (→ live:'error', fail closed). Default 4000. */
  timeoutMs?: number;
  /**
   * Bypass the cache READ and always do the live server check — for writes / sensitive reads. The
   * cache can serve a stale "valid" verdict for a token that has since been logged out / revoked
   * (we get no logout event to evict it); force-fresh closes that window. The fresh verdict is still
   * written back, so it OVERWRITES a stale entry (a now-invalid token's cached "valid" becomes
   * "invalid"). Use it on the operations where ≤`maxLiveTtlSeconds` of staleness is unacceptable.
   */
  forceFresh?: boolean;
  /** Audience to require — default "ns". Always enforced locally (cheap, before any roundtrip). */
  expectedAud?: string | string[];
  /** Issuer(s) to require — YOUR portal host(s), e.g. "manage.example.com", or a list when one backend
   *  is fronted by several portal hostnames. Exact match, no wildcards. No default: required unless
   *  `validateIss: false`. Omitting both fails closed. */
  expectedIss?: string | string[];
  /** Set false to skip issuer validation (e.g. work across portal domains). Default true, which makes
   *  `expectedIss` mandatory. */
  validateIss?: boolean;
  /** ns_t HS256 shared secret. When set, the signature is verified LOCALLY FIRST (forged/tampered
   *  tokens are rejected with no roundtrip). When unset, `signature` is 'unverified' and the live
   *  `/jwt` check is the signature authority. */
  signingSecret?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

/**
 * Full gate. Order: cheap local format+exp → (live mode) cached live verdict → live GET /jwt.
 * A malformed/expired token returns immediately and never touches the server.
 */
export async function verify(token: string, opts: VerifyOptions): Promise<JwtVerdict> {
  const nowMs = opts.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const fmt = validateJwtFormat(token, nowMs);

  const base: JwtVerdict = {
    validFormat: fmt.validFormat,
    unexpired: fmt.unexpired,
    live: 'skipped',
    ok: false,
    ...fmt.context,
    ...(fmt.expiresAt ? { expiresAt: fmt.expiresAt } : {}),
    ...(fmt.expiresInSeconds !== undefined ? { expiresInSeconds: fmt.expiresInSeconds } : {}),
    ...(fmt.reason ? { reason: fmt.reason } : {}),
    payload: fmt.payload,
    checkedAt,
  };

  // Local gate: bad format or expired ⇒ reject without a roundtrip.
  if (!fmt.validFormat || !fmt.unexpired) return base;

  // Claim assertions (always, no key needed): aud must be "ns"; iss must match unless opted out.
  const claims = assertClaims(fmt.payload ?? {}, { aud: opts.expectedAud, iss: opts.expectedIss, validateIss: opts.validateIss });
  if (!claims.ok) return { ...base, ok: false, reason: claims.reason };

  // Signature: when a shared secret is configured, verify HS256 LOCALLY FIRST (reject forgeries with
  // no roundtrip). Without a secret we can't verify locally (no public JWKS) → 'unverified', and the
  // live check below is the authority.
  let signature: JwtVerdict['signature'] = 'unverified';
  if (opts.signingSecret) {
    signature = (await verifyHs256Signature(token, opts.signingSecret)) ? 'valid' : 'invalid';
    if (signature === 'invalid') return { ...base, signature, ok: false, reason: 'Signature verification failed' };
  }
  const withSig = { ...base, signature };

  if ((opts.mode ?? 'live') === 'format') {
    // Local-only mode. `ok` means AUTHENTICATED, so it requires a locally-verified signature
    // (`signingSecret`). ns_t has no public JWKS, so without a secret the signature is 'unverified' ⇒
    // ok:false (structurally + aud/iss valid, but NOT attested). Use mode:'live' — the server-side
    // signature authority — to actually authenticate an ns_t.
    return signature === 'valid'
      ? { ...withSig, live: 'skipped', ok: true }
      : { ...withSig, live: 'skipped', ok: false, reason: 'Signature not verified (format mode without signingSecret)' };
  }

  // Live mode — consult cache first (unless force-fresh: writes/sensitive reads always re-check).
  const key = await tokenKey(token);
  if (opts.cache && !opts.forceFresh) {
    const cached = await opts.cache.get(key);
    if (cached) return { ...cached, fromCache: true, checkedAt };
  }

  // Cache miss → the one server roundtrip. This is the SIGNATURE/revocation authority, so make it
  // brittle-safe: a timeout (a hung NS core can't tie up the request), NO redirect following
  // (`manual`), and ONLY a literal 200 counts as valid — any 3xx/5xx/other fails closed, uncached.
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  let verdict: JwtVerdict;
  try {
    const res = await doFetch(`https://${opts.server}/ns-api/v2/jwt`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${normalizeToken(token)}` },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      verdict = { ...withSig, live: 'invalid', ok: false, statusCode: res.status, reason: `JWT rejected by API (${res.status})` };
    } else if (res.status === 200) {
      verdict = { ...withSig, live: 'valid', ok: true, statusCode: res.status };
    } else {
      // Anything else (3xx redirect, 5xx, opaque, 0) — don't trust it. Fail closed, don't cache.
      verdict = { ...withSig, live: 'error', ok: false, statusCode: res.status, reason: `Unexpected /jwt status ${res.status}` };
    }
  } catch (err) {
    verdict = { ...withSig, live: 'error', ok: false, reason: `JWT check failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }

  // Cache valid/invalid verdicts (never 'error'). TTL capped by the token's own exp.
  if (opts.cache && (verdict.live === 'valid' || verdict.live === 'invalid')) {
    const cap = verdict.live === 'valid' ? (opts.maxLiveTtlSeconds ?? 60) : (opts.negativeTtlSeconds ?? 30);
    const untilExp = fmt.expiresInSeconds ?? 0;
    const ttl = verdict.live === 'valid' ? Math.max(0, Math.min(cap, untilExp)) : cap;
    // Trim the full decoded claims blob before persisting: nothing downstream reads verdict.payload
    // (toPrincipal uses the typed context fields), and it's the largest PII surface to leave sitting
    // in the per-colo cache. Keep it on the returned verdict (this request only), drop it from storage.
    const { payload: _payload, ...cacheable } = verdict;
    if (ttl > 0) await opts.cache.set(key, cacheable, ttl);
  }

  return verdict;
}
