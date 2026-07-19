/**
 * evaluateEligibility — is a NetSapiens user a real end-user candidate for an app integration (Ringotel,
 * or any other)? Pure and deployment-neutral. The name is generic on purpose: the config/rules define the
 * purpose. Consumers supply an EligibilityConfig; env parsing lives in each consumer, never here.
 *
 *   HARD  — system/service users (srv_code) + structurally-invalid extensions. Never eligible, not even a
 *           reseller override.
 *   SOFT  — name matchers, extension lists, no-device heuristic. Default-excluded, reseller-overridable
 *           per configured category (or via an explicit per-request `force`).
 *   email — a precondition: activation typically emails credentials, so it can't proceed without an address.
 * Precedence: HARD → SOFT (names, exts) → precondition → ok.
 */

export type SoftCategory = 'names' | 'exts' | 'no_devices';

export interface EligibilityConfig {
  /** Lowercased name-contains matchers (checked against first/last/display). Caller lowercases. */
  excludeNames: string[];
  /** Global extension exclusions (exact, or trailing-`*` prefix). */
  excludeExts: string[];
  /** Per-domain override of the extension list (add/remove relative to global). */
  excludeExtsByDomain: Record<string, { add?: string[]; remove?: string[] }>;
  /** No-device heuristic: TIGHTENS a name match (never decides alone). */
  excludeNoDevices: boolean;
  /** Soft categories a reseller may override. */
  resellerOverride: Set<SoftCategory>;
}

export interface EligUser {
  ext: string;
  srvCode?: string;
  email?: string;
  names?: string[];
  deviceCount?: number;
}

export interface EligContext {
  domain: string;
  isReseller: boolean;
  /** Reseller RUNTIME force: bypass ALL soft categories — never HARD, never the email precondition. */
  force?: boolean;
}

export type EligTier = 'ok' | 'hard' | 'soft' | 'precondition';
export interface EligResult {
  activatable: boolean;
  tier: EligTier;
  reasons: string[];
}

const blank = (s?: string): boolean => !s || s.trim() === '';

function excludedExtsFor(config: EligibilityConfig, domain: string): string[] {
  const dom = config.excludeExtsByDomain[domain] ?? {};
  const set = new Set(config.excludeExts);
  for (const a of dom.add ?? []) set.add(a);
  for (const r of dom.remove ?? []) set.delete(r);
  return [...set];
}

function extMatch(ext: string, patterns: string[]): string | undefined {
  return patterns.find((p) => (p.endsWith('*') ? ext.startsWith(p.slice(0, -1)) : ext === p));
}

export function evaluateEligibility(user: EligUser, ctx: EligContext, config: EligibilityConfig): EligResult {
  if (!blank(user.srvCode)) {
    return { activatable: false, tier: 'hard', reasons: [`system/service user (srv_code="${user.srvCode!.trim()}")`] };
  }
  if (!/^\d{3,4}$/.test(user.ext)) {
    return { activatable: false, tier: 'hard', reasons: [`extension "${user.ext}" is not a 3-4 digit user extension`] };
  }

  const canOverride = (cat: SoftCategory): boolean => ctx.isReseller && (config.resellerOverride.has(cat) || !!ctx.force);

  const names = (user.names ?? []).map((n) => (n || '').toLowerCase());
  const nameMatch = config.excludeNames.find((m) => names.some((n) => n.includes(m)));
  const nameHit = nameMatch && (!config.excludeNoDevices || (user.deviceCount ?? 0) === 0);
  if (nameHit && !canOverride('names')) {
    return { activatable: false, tier: 'soft', reasons: [`name matches excluded pattern "${nameMatch}"`] };
  }

  const extHit = extMatch(user.ext, excludedExtsFor(config, ctx.domain));
  if (extHit && !canOverride('exts')) {
    return { activatable: false, tier: 'soft', reasons: [`extension "${user.ext}" matches excluded pattern "${extHit}"`] };
  }

  if (blank(user.email)) {
    return { activatable: false, tier: 'precondition', reasons: ['an email address is required to activate'] };
  }

  return { activatable: true, tier: 'ok', reasons: [] };
}
