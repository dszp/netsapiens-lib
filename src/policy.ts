/**
 * A small, declarative allow-list policy engine over `Principal` — the extensible knob for gating
 * features by who's asking. Designed so new gates are one object, not new code.
 *
 * A `Policy` is a list of `PolicyRule`s; a principal is granted the feature if **any** rule matches
 * (default DENY — an empty policy or an unknown feature denies). Within a rule, every specified
 * condition must hold (AND); an omitted condition is a wildcard. All string comparisons are
 * case-insensitive.
 *
 * Conditions, and the shapes they're meant to express:
 *  - by scope, per-domain:            { scopes: ['Office Manager'] }            // + domain-locked elsewhere
 *  - one reseller vs all resellers:   { scopes:['Reseller'], users:['admin@0000.12345.service'] }  vs  { scopes:['Reseller'] }
 *  - all users in some domains:       { domains: ['acme','acme42'] }
 *  - …optionally with scopes:         { domains:['acme'], scopes:['Office Manager','Basic User'] }
 *  - specific users:                  { users: ['100@acme','101@acme'] }
 *  - only when a given operator is masked in: { operators: ['admin@0000.12345.service'] }
 *  - only while (not) masking:        { masking: true }  /  { masking: false }
 *
 * Matching considers the EFFECTIVE principal (scope/domain/id = the masked user when masking);
 * `operators` matches the mask_chain operator, so you can gate on the real reseller behind a mask.
 *
 * Portable (no Node). Pure functions.
 */
import type { Principal } from './principal.js';

export interface PolicyRule {
  /** Effective scope must be one of these (case-insensitive). */
  scopes?: string[];
  /** Effective domain must be one of these. Use '*' to match any domain. */
  domains?: string[];
  /** Effective identity (`user@domain`) must be one of these. */
  users?: string[];
  /** Requires masking, AND the operator's `user@domain` (mask_chain) is one of these. */
  operators?: string[];
  /** Require the masking state to equal this (true = masked, false = not masked). */
  masking?: boolean;
  /** Optional human note (documentation / audit; ignored by matching). */
  description?: string;
}

/** ANY rule matching grants the feature; `[]` denies. */
export type Policy = PolicyRule[];

/** Named features → their policy. Unknown feature ⇒ deny (see `can`). */
export type FeaturePolicies = Record<string, Policy>;

const lc = (s: string) => s.trim().toLowerCase();
const inList = (value: string, list: string[]): boolean => {
  const v = lc(value);
  return list.some((x) => lc(x) === v);
};

/** Does the principal satisfy every condition in this single rule? */
export function ruleMatches(p: Principal, rule: PolicyRule): boolean {
  // A rule with NO matchable condition (e.g. `{}` or only `description`) is NOT allow-all — that would
  // silently grant everyone. Require at least one real condition; a conditionless rule never matches.
  const hasCondition =
    rule.scopes !== undefined ||
    rule.domains !== undefined ||
    rule.users !== undefined ||
    rule.operators !== undefined ||
    rule.masking !== undefined;
  if (!hasCondition) return false;
  if (rule.scopes && !inList(p.scope, rule.scopes)) return false;
  if (rule.domains && !(rule.domains.includes('*') || inList(p.domain, rule.domains))) return false;
  if (rule.users && !inList(p.id, rule.users)) return false;
  if (rule.operators) {
    if (!p.operator || !inList(p.operator.id, rule.operators)) return false;
  }
  if (rule.masking !== undefined && p.masking !== rule.masking) return false;
  return true;
}

/** Allowed if any rule matches. Empty/absent policy ⇒ deny (fail closed). */
export function isAllowed(p: Principal, policy: Policy | undefined): boolean {
  return !!policy && policy.some((rule) => ruleMatches(p, rule));
}

/** Check a named feature against a registry. Unknown feature ⇒ deny (fail closed). */
export function can(p: Principal, feature: string, policies: FeaturePolicies): boolean {
  return isAllowed(p, policies[feature]);
}
