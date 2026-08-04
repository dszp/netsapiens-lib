/**
 * Which NetSapiens v2 write operations accept the `synchronous` request-body flag.
 *
 * `synchronous: 'yes'` asks the API to complete the write before replying, so the response is
 * **200 with the resulting resource inline** — including server-generated fields a caller cannot
 * otherwise learn without a second read (a new device's SIP registration password is the worked
 * example). Without it, or on an operation that does not support it, the API replies
 * **202 Accepted** with a bare `{code, message}` acknowledgement and applies the write behind the
 * scenes.
 *
 * **It is a per-operation capability, not a global one.** Only the operations listed below declare
 * a `synchronous` property in the v2 OpenAPI specification (core 44.4.10) — 17 of them, almost all
 * creates. Sending the flag to any other endpoint is inert: NetSapiens ignores unrecognized body
 * fields and still answers 202. That is harmless but misleading, because it makes code look as
 * though it has a synchronous guarantee it never had.
 *
 * The most consequential absence is **`PUT /domains/{domain}/users/{user}`** — a user *update*
 * cannot be made synchronous, though a user *create* can. Verified live 2026-08-03: the flag in the
 * body, as `?synchronous=yes`, as `?synchronous=true`, both at once, and omitted entirely all return
 * an identical 202 on that endpoint. Any confirmation of a user update has to come from reading the
 * record back, not from the response.
 *
 * Kept as data rather than folded into each method so both this library's write client and other
 * NetSapiens clients can share one answer instead of drifting apart.
 */

/** The HTTP methods any `synchronous`-capable operation uses. */
export type SynchronousMethod = 'POST' | 'PUT';

/** One operation that accepts `synchronous`, as a method plus an OpenAPI-style templated path. */
export interface SynchronousOperation {
  method: SynchronousMethod;
  /** Templated path, e.g. `/domains/{domain}/users`. A `{...}` segment matches exactly one path segment. */
  path: string;
}

/**
 * Every operation declaring `synchronous` in the v2 spec (core 44.4.10), deduplicated — the
 * specification lists several of these more than once under `#1`…`#4` suffixes for differing
 * request shapes, which are the same HTTP operation.
 *
 * Note the near-misses, which are the whole reason this list is explicit: user and domain **create**
 * are here, user **update** is not; greeting and MOH **update** are here, device update is not.
 */
export const SYNCHRONOUS_OPERATIONS: readonly SynchronousOperation[] = [
  { method: 'POST', path: '/domains' },
  { method: 'POST', path: '/domains/{domain}/callqueues' },
  { method: 'POST', path: '/domains/{domain}/callqueues/{callqueue}/agents' },
  { method: 'POST', path: '/domains/{domain}/dialplans/{dialplan}/dialrules' },
  { method: 'POST', path: '/domains/{domain}/moh' },
  { method: 'PUT', path: '/domains/{domain}/moh/{index}' },
  { method: 'PUT', path: '/domains/{domain}/sites/{site}' },
  { method: 'POST', path: '/domains/{domain}/timeframes' },
  { method: 'POST', path: '/domains/{domain}/users' },
  { method: 'POST', path: '/domains/{domain}/users/{user}/answerrules' },
  { method: 'POST', path: '/domains/{domain}/users/{user}/calls' },
  { method: 'POST', path: '/domains/{domain}/users/{user}/devices' },
  { method: 'POST', path: '/domains/{domain}/users/{user}/greetings' },
  { method: 'PUT', path: '/domains/{domain}/users/{user}/greetings/{index}' },
  { method: 'POST', path: '/domains/{domain}/users/{user}/moh' },
  { method: 'PUT', path: '/domains/{domain}/users/{user}/moh/{index}' },
  { method: 'POST', path: '/domains/{domain}/users/{user}/timeframes' },
] as const;

/** Split a path into non-empty segments, ignoring any query string and leading/trailing slashes. */
const segmentsOf = (path: string): string[] => (path.split('?')[0] ?? '').split('/').filter(Boolean);

/** Precomputed segment forms, so a lookup is a comparison rather than a re-parse per call. */
const TABLE: ReadonlyArray<{ method: SynchronousMethod; segments: readonly string[] }> =
  SYNCHRONOUS_OPERATIONS.map((op) => ({ method: op.method, segments: segmentsOf(op.path) }));

/**
 * Does `method path` accept `synchronous`?
 *
 * `path` is a concrete request path relative to the `/ns-api/v2` base, with its dynamic segments
 * already filled in and URI-encoded — exactly what a client passes to `post()`/`put()`. Encoding is
 * what makes the match safe: a value containing a slash arrives as `%2F` and stays one segment, so
 * it cannot masquerade as a deeper path.
 *
 * Unknown paths answer `false`. That is the safe direction: the flag is then omitted, and the caller
 * gets the 202 it would have received anyway — rather than a promise of a 200 that never arrives.
 */
export function supportsSynchronous(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if (verb !== 'POST' && verb !== 'PUT') return false;

  const actual = segmentsOf(path);
  return TABLE.some(
    (op) =>
      op.method === verb &&
      op.segments.length === actual.length &&
      op.segments.every((seg, i) =>
        seg.startsWith('{') && seg.endsWith('}')
          ? true // a template segment matches any single segment
          : seg.toLowerCase() === actual[i]!.toLowerCase(),
      ),
  );
}
