import { describe, it, expect } from 'vitest';
import { evaluateEligibility, type EligibilityConfig, type EligContext } from './eligibility.js';

const cfg = (over: Partial<EligibilityConfig> = {}): EligibilityConfig => ({
  excludeNames: ['shared', 'fax'],
  excludeExts: [],
  excludeExtsByDomain: {},
  excludeNoDevices: false,
  resellerOverride: new Set(),
  ...over,
});
const ctx: EligContext = { domain: 'demo.12345.service', isReseller: false };

describe('evaluateEligibility', () => {
  it('ok — a normal user with an email', () => {
    const r = evaluateEligibility({ ext: '100', email: 'a@example.com', names: ['Alice'] }, ctx, cfg());
    expect(r).toEqual({ activatable: true, tier: 'ok', reasons: [] });
  });

  it('hard — system/service user (srv_code) is never activatable', () => {
    const r = evaluateEligibility({ ext: '100', email: 'a@example.com', srvCode: 'x' }, ctx, cfg());
    expect(r.activatable).toBe(false);
    expect(r.tier).toBe('hard');
  });

  it('hard — non 3-4 digit extension', () => {
    const r = evaluateEligibility({ ext: '9001234', email: 'a@example.com' }, ctx, cfg());
    expect(r.tier).toBe('hard');
  });

  it('soft — excluded name pattern blocks by default', () => {
    const r = evaluateEligibility({ ext: '100', email: 'a@example.com', names: ['SHARED VOICEMAIL'] }, ctx, cfg());
    expect(r.tier).toBe('soft');
  });

  it('soft overridden — reseller force bypasses the name rule', () => {
    const r = evaluateEligibility(
      { ext: '100', email: 'a@example.com', names: ['FAX'] },
      { ...ctx, isReseller: true, force: true },
      cfg(),
    );
    expect(r.activatable).toBe(true);
  });

  it('precondition — no email blocks even an otherwise-ok user', () => {
    const r = evaluateEligibility({ ext: '100', names: ['Bob'] }, ctx, cfg());
    expect(r.tier).toBe('precondition');
  });

  it('per-domain ext exclusion applies', () => {
    const c = cfg({ excludeExtsByDomain: { 'demo.12345.service': { add: ['100'] } } });
    const r = evaluateEligibility({ ext: '100', email: 'a@example.com' }, ctx, c);
    expect(r.tier).toBe('soft');
  });
});
