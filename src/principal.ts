/**
 * Normalize an ns_t JWT's claims into a `Principal` — the identity + role the portal authorizes
 * against. Handles NetSapiens **masking** (impersonation): when a reseller/admin is masked-in as a
 * domain user, the token's `domain`/`user`/`scope`/`sub` describe the MASKED user, while `mask_chain`
 * names the real operator. `Principal` keeps both, plus a `masking` flag.
 *
 * Two things the caller must keep straight (see policy.ts):
 *  - **Auth scope** (what data is reachable) follows the EFFECTIVE identity: a masked token is
 *    NS-scoped to the masked user's domain; only an un-masked reseller/super-user reads cross-domain.
 *  - **Role gating** may consider the OPERATOR (mask_chain) too — e.g. "allow my reseller while
 *    developing" — since the effective scope reads "Office Manager" while masked.
 *
 * Portable (no Node). Pure functions.
 */
import type { JwtContext } from './jwt.js';

/** Known NetSapiens user scopes (the string is open — unknown scopes pass through as-is). */
export type Scope =
  | 'Super User'
  | 'Reseller'
  | 'Office Manager'
  | 'Site Manager'
  | 'Call Center Supervisor'
  | 'Call Center Agent'
  | 'Basic User'
  | (string & {});

/** The real operator behind a mask (parsed from `mask_chain`). */
export interface Operator {
  /** `user@domain` (verbatim mask_chain, lowercased id below). */
  raw: string;
  user: string;
  domain: string;
  /** Lowercased `user@domain` for comparisons. */
  id: string;
}

export interface Principal {
  /** Effective domain — the masked user's when masking; the token is NS-scoped to it. */
  domain: string;
  /** Effective user / extension. */
  user: string;
  /** Effective identity `user@domain`, lowercased (from sub, or user+domain). */
  id: string;
  /** Effective user_scope (the masked user's scope when masking). */
  scope: string;
  email?: string;
  displayName?: string;
  territory?: string;
  /** True when a mask is in effect (mask_chain present). */
  masking: boolean;
  /** The real operator behind the mask, or null when not masking. */
  operator: Operator | null;
}

const lc = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/** Scopes that can read/act across the whole reseller/fleet (cross-domain). */
const RESELLER_SCOPES = new Set(['reseller', 'super user', 'superuser', 'super-user']);
/** Scopes with domain-admin authority (a superset that includes reseller-level). */
const ADMIN_SCOPES = new Set([...RESELLER_SCOPES, 'office manager', 'site manager', 'call center supervisor']);

/** Reseller / super-user — the only scopes that legitimately read cross-domain. */
export function isResellerScope(scope: string | undefined): boolean {
  return RESELLER_SCOPES.has(lc(scope));
}
/** Domain-admin-or-higher (office manager / site manager / supervisor / reseller / super user). */
export function isAdminScope(scope: string | undefined): boolean {
  return ADMIN_SCOPES.has(lc(scope));
}

/** Parse a `mask_chain` value ("user@domain") into an Operator, or null if empty/malformed. */
export function parseOperator(maskChain: string | undefined): Operator | null {
  const raw = (maskChain ?? '').trim();
  if (!raw || !raw.includes('@')) return null;
  const at = raw.lastIndexOf('@');
  const user = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!user || !domain) return null;
  return { raw, user, domain, id: `${user}@${domain}`.toLowerCase() };
}

/** Build a Principal from decoded ns_t context (a JwtContext / JwtVerdict — both carry the claims). */
export function toPrincipal(ctx: JwtContext): Principal {
  const domain = (ctx.domain ?? '').trim();
  const user = (ctx.user ?? '').trim();
  const sub = (ctx.sub ?? '').trim();
  const id = (sub.includes('@') ? sub : user && domain ? `${user}@${domain}` : sub || user).toLowerCase();
  const operator = parseOperator(ctx.maskChain);
  return {
    domain,
    user,
    id,
    scope: (ctx.scope ?? '').trim(),
    ...(ctx.email ? { email: ctx.email } : {}),
    ...(ctx.displayName ? { displayName: ctx.displayName } : {}),
    ...(ctx.territory ? { territory: ctx.territory } : {}),
    masking: operator != null,
    operator,
  };
}
