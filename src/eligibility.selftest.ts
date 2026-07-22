/**
 * Offline test for evaluateEligibility — pure predicate, no fetch/mocking needed. Asserts precedence
 * (hard > soft > precondition > ok): srv_code + non-3-4-digit ext are hard; excluded name/ext patterns
 * are soft (reseller-overridable via force); missing email is a precondition; per-domain ext exclusion
 * layers onto the global list. tsx src/eligibility.selftest.ts
 */
import { evaluateEligibility, type EligibilityConfig, type EligContext } from './index.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

const cfg = (over: Partial<EligibilityConfig> = {}): EligibilityConfig => ({
  excludeNames: ['shared', 'fax'],
  excludeExts: [],
  excludeExtsByDomain: {},
  excludeNoDevices: false,
  resellerOverride: new Set(),
  ...over,
});
const ctx: EligContext = { domain: 'demo.12345.service', isReseller: false };

// ok — a normal user with an email
{
  const r = evaluateEligibility({ ext: '100', email: 'a@example.com', names: ['Alice'] }, ctx, cfg());
  ok(r.activatable === true && r.tier === 'ok' && r.reasons.length === 0, 'ok — a normal user with an email');
}

// hard — system/service user (srv_code) is never activatable
{
  const r = evaluateEligibility({ ext: '100', email: 'a@example.com', srvCode: 'x' }, ctx, cfg());
  ok(r.activatable === false && r.tier === 'hard', 'hard — system/service user (srv_code) is never activatable');
}

// hard — non 3-4 digit extension
{
  const r = evaluateEligibility({ ext: '9001234', email: 'a@example.com' }, ctx, cfg());
  ok(r.tier === 'hard', 'hard — non 3-4 digit extension');
}

// soft — excluded name pattern blocks by default
{
  const r = evaluateEligibility({ ext: '100', email: 'a@example.com', names: ['SHARED VOICEMAIL'] }, ctx, cfg());
  ok(r.tier === 'soft', 'soft — excluded name pattern blocks by default');
}

// soft overridden — reseller force bypasses the name rule
{
  const r = evaluateEligibility(
    { ext: '100', email: 'a@example.com', names: ['FAX'] },
    { ...ctx, isReseller: true, force: true },
    cfg(),
  );
  ok(r.activatable === true, 'soft overridden — reseller force bypasses the name rule');
}

// precondition — no email blocks even an otherwise-ok user
{
  const r = evaluateEligibility({ ext: '100', names: ['Bob'] }, ctx, cfg());
  ok(r.tier === 'precondition', 'precondition — no email blocks even an otherwise-ok user');
}

// per-domain ext exclusion applies
{
  const c = cfg({ excludeExtsByDomain: { 'demo.12345.service': { add: ['100'] } } });
  const r = evaluateEligibility({ ext: '100', email: 'a@example.com' }, ctx, c);
  ok(r.tier === 'soft', 'per-domain ext exclusion applies');
}

// emailNotRequired — waives ONLY the email precondition (login-delivered credentials), and the waiver
// stays visible via emailWaived so a caller still knows there is no address to mail.
{
  const r = evaluateEligibility({ ext: '100', names: ['Alice'] }, { ...ctx, emailNotRequired: true }, cfg());
  ok(r.activatable === true && r.tier === 'ok', 'emailNotRequired — no email is eligible');
  ok(r.emailWaived === true, 'emailNotRequired — the waiver is reported via emailWaived');
  ok(r.reasons.length === 1, 'emailNotRequired — the missing address is still stated in reasons');
}
{
  const r = evaluateEligibility({ ext: '100', email: 'a@example.com' }, { ...ctx, emailNotRequired: true }, cfg());
  ok(r.tier === 'ok' && r.emailWaived === undefined, 'emailNotRequired with an address present — nothing waived');
}
{
  const r = evaluateEligibility({ ext: '100', srvCode: 'x' }, { ...ctx, emailNotRequired: true }, cfg());
  ok(r.tier === 'hard' && r.emailWaived === undefined, 'emailNotRequired does NOT rescue a HARD user');
}
{
  const r = evaluateEligibility({ ext: '100', names: ['SHARED VOICEMAIL'] }, { ...ctx, emailNotRequired: true }, cfg());
  ok(r.tier === 'soft' && r.emailWaived === undefined, 'emailNotRequired does NOT rescue a SOFT exclusion');
}
{
  const r = evaluateEligibility({ ext: '100', names: ['Alice'] }, ctx, cfg());
  ok(r.tier === 'precondition' && r.emailWaived === undefined, 'without the flag the precondition still fires');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
