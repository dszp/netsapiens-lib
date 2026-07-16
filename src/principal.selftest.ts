/**
 * Principal + policy engine proof, driven by two ns_t claim sets that mirror the shapes the real
 * platform emits: a reseller acting as self (no mask), and a domain user being impersonated by a
 * reseller (`mask_chain` set). Identities are fictional — the SHAPE is what's under test.
 *
 * The masked case is the interesting one: `sub`/`domain`/`user_scope` describe the MASKED user, while
 * `mask_chain` carries the real operator behind the mask. Getting that backwards is the bug this
 * fixture exists to catch.
 *
 * Run: `pnpm test:principal`.
 */
import { extractContext } from './jwt.js';
import { toPrincipal, isResellerScope, isAdminScope } from './principal.js';
import { can, isAllowed, type FeaturePolicies } from './policy.js';

// Claim sets shaped exactly like the platform's, with fictional identities.
const RESELLER_SELF = {
  aud: 'ns', iss: 'manage.example.com', sub: 'admin@0000.12345.service',
  domain: '0000.12345.service', territory: '12345.service', user: 'admin',
  user_email: 'alex@acme42.example', user_scope: 'Reseller', displayName: 'Alex Reseller',
  mask_chain: null,
};
const RESELLER_MASKED = {
  aud: 'ns', iss: 'manage.example.com', sub: '100@acme',
  domain: 'acme', territory: '12345.service', user: '100',
  user_email: 'jordan@acme.example', user_scope: 'Office Manager', displayName: 'Jordan Manager',
  mask_chain: 'operator@0000.12345.service',
};

const self = toPrincipal(extractContext(RESELLER_SELF as Record<string, unknown>));
const masked = toPrincipal(extractContext(RESELLER_MASKED as Record<string, unknown>));

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name)); };

// ---- normalization ----
check('self: not masking', self.masking === false && self.operator === null);
check('self: reseller scope + id', self.scope === 'Reseller' && self.id === 'admin@0000.12345.service');
check('self: domain', self.domain === '0000.12345.service');
check('masked: masking flag', masked.masking === true);
check('masked: effective is the masked user (acme/100/Office Manager)',
  masked.domain === 'acme' && masked.user === '100' && masked.scope === 'Office Manager' && masked.id === '100@acme');
check('masked: operator is the real reseller', masked.operator?.id === 'operator@0000.12345.service');
check('masked: identity fields surfaced', masked.email === 'jordan@acme.example' && masked.displayName === 'Jordan Manager');

// ---- scope helpers ----
check('isResellerScope(self)', isResellerScope(self.scope) === true);
check('isResellerScope(masked effective) is FALSE (scope reads Office Manager while masked)', isResellerScope(masked.scope) === false);
check('isAdminScope(masked) true (Office Manager)', isAdminScope(masked.scope) === true);
check('isResellerScope case-insensitive', isResellerScope('reseller') && isResellerScope('SUPER USER'));

// ---- policy cases ----
check('all resellers: self yes, masked no', isAllowed(self, [{ scopes: ['Reseller'] }]) && !isAllowed(masked, [{ scopes: ['Reseller'] }]));
check('my reseller only: self yes',
  isAllowed(self, [{ scopes: ['Reseller'], users: ['admin@0000.12345.service'] }]));
check('my reseller only: a different reseller no',
  !isAllowed({ ...self, id: 'someoneelse@0000.12345.service' }, [{ scopes: ['Reseller'], users: ['admin@0000.12345.service'] }]));
check('office managers: masked yes, self no', isAllowed(masked, [{ scopes: ['Office Manager'] }]) && !isAllowed(self, [{ scopes: ['Office Manager'] }]));
check('all users in acme: masked yes, self no', isAllowed(masked, [{ domains: ['acme'] }]) && !isAllowed(self, [{ domains: ['acme'] }]));
check('domains with scope filter', isAllowed(masked, [{ domains: ['acme'], scopes: ['Office Manager', 'Basic User'] }]));
check('specific users: masked yes', isAllowed(masked, [{ users: ['100@acme'] }]));
check('operator gate (only when my reseller masked-in): masked yes, self no',
  isAllowed(masked, [{ operators: ['operator@0000.12345.service'] }]) && !isAllowed(self, [{ operators: ['operator@0000.12345.service'] }]));
check('masking:false rule: self yes, masked no', isAllowed(self, [{ masking: false }]) && !isAllowed(masked, [{ masking: false }]));
check("domain '*' wildcard matches any", isAllowed(self, [{ domains: ['*'] }]) && isAllowed(masked, [{ domains: ['*'] }]));
check('ANY-rule semantics (union of two rules)',
  isAllowed(masked, [{ scopes: ['Reseller'] }, { domains: ['acme'] }]));
check('empty policy denies', !isAllowed(self, []));
check('conditionless rule does NOT match (no accidental allow-all)', !isAllowed(self, [{}]) && !isAllowed(self, [{ description: 'todo' }]));

// ---- feature registry (fail-closed) ----
const FEATURES: FeaturePolicies = {
  'callflow.view': [{ scopes: ['Reseller'] }, { operators: ['operator@0000.12345.service'] }], // resellers, or my masked previews
  'admin.publish': [{ scopes: ['Reseller', 'Super User'] }],
};
check('feature callflow.view: self(reseller) yes', can(self, 'callflow.view', FEATURES));
check('feature callflow.view: masked-by-my-reseller yes (via operator rule)', can(masked, 'callflow.view', FEATURES));
check('feature admin.publish: masked office-manager no', !can(masked, 'admin.publish', FEATURES));
check('unknown feature denies (fail closed)', !can(self, 'does.not.exist', FEATURES));

console.log(`\nprincipal.selftest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
