/**
 * Which calls need a FRESH live JWT revalidation (bypassing the verdict cache) — a *can't-forget*
 * classification. Logout/revocation is server-side and we get no event to evict the cache, so
 * write/sensitive operations must force-fresh (`verify({ forceFresh: true })`) or they'd accept a
 * logged-out token for up to the cache TTL. Plain reads stay cache-fronted (cheap).
 *
 * The reminder is structural, not a comment you can skip: every portal route's config must satisfy
 * `RouteAuth`, whose `sensitivity` is REQUIRED. Adding a route without classifying it is a TypeScript
 * error — so you can't forget. Derive the verify option straight from it:
 *
 *   const ROUTES = {
 *     '/flow':    { sensitivity: 'read',      handle: getFlow },
 *     '/publish': { sensitivity: 'write',     handle: publish },
 *     '/preview': { sensitivity: 'sensitive', handle: preview },
 *   } satisfies Record<string, RouteAuth & { handle: Handler }>;   // ← omitting sensitivity won't compile
 *
 *   const route = ROUTES[path];
 *   const verdict = await verify(ns_t, { mode: 'live', cache, forceFresh: needsFreshAuth(route.sensitivity) });
 *
 * Portable (no Node).
 */

/** read = safe to serve from the cached JWT verdict. sensitive/write = must revalidate live. */
export type CallSensitivity = 'read' | 'sensitive' | 'write';

/** True when a call must force a fresh live JWT check (bypass the verdict cache). */
export function needsFreshAuth(sensitivity: CallSensitivity): boolean {
  return sensitivity !== 'read';
}

/** Base shape every route config MUST satisfy — `sensitivity` is required (that's the reminder). */
export interface RouteAuth {
  sensitivity: CallSensitivity;
}

/** Human note surfaced in docs/registries so the rule is visible where routes are defined. */
export const SENSITIVITY_NOTE =
  'Every portal route MUST declare `sensitivity` (read | sensitive | write). write/sensitive ⇒ verify ' +
  'with forceFresh (bypass the JWT verdict cache) so logout/revocation is caught immediately; read ⇒ ' +
  'cache-fronted verify. A missing classification is a compile error via `satisfies Record<string, RouteAuth>`.';
