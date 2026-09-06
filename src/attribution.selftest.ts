/** Offline test for item→site attribution. pnpm test:attribution */
import { attributeDomainInventory } from './attribution.js';
import { listDomainInventory } from './inventory.js';
import type { Snapshot } from './model.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

const snap: Snapshot = {
  meta: { domain: 'acme.example' },
  users: [
    { user: '100', site: 'North', 'service-code': '', 'emergency-address-id': 'a-1' },
    { user: '101', site: 'South', 'service-code': '', 'emergency-address-id': 'a-1' },
    { user: '102', site: 'South', 'service-code': '', 'emergency-address-id': 'a-2' },
    { user: '103', site: '', 'service-code': '' },                       // no site
    { user: '701', site: 'North', 'service-code': 'system-queue' },       // a queue is a user too
    { user: '702', site: '', 'service-code': 'system-tod' },              // a site-less system user
  ],
  phonenumbers: [
    { phonenumber: '13175550100', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '100' },
    { phonenumber: '13175550101', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '701' },
    { phonenumber: '13175550102', 'dial-rule-application': 'to-connection', 'dial-rule-translation-destination-user': '' },
    { phonenumber: '13175550103', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '103' },
    { phonenumber: '13175550104', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '999' },
    { phonenumber: '13175550106', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '702' },
  ],
  addresses: [
    { 'emergency-address-id': 'a-1', 'address-name': 'Shared' },
    { 'emergency-address-id': 'a-2', 'address-name': 'South only' },
    { 'emergency-address-id': 'a-3', 'address-name': 'Nobody' },
  ],
  smsnumbers: [{ number: '13175550100' }, { number: '13175550102' }, { number: '13175550199' }],
  smsNumbersByUser: { '100': [{ number: '13175550100' }], '103': [{ number: '13175550102' }] },
};

const a = attributeDomainInventory(snap).items;
const d = listDomainInventory(snap);
const allKeys = [...d.extensions, ...d.dids, ...d.e911Addresses, ...d.smsNumbers].map((i) => i.key);
ok(allKeys.every((k) => k in a), 'every extension, number, address and SMS number has an attribution');
ok(Object.keys(a).length === allKeys.length, 'and nothing else does (system users are not items)');

ok(a['ext:100']!.site === 'North' && a['ext:100']!.how === 'own-site', 'an extension is attributed to its own site');
ok(a['ext:103']!.site === null && a['ext:103']!.how === 'unattributed:no-site', 'an extension with a blank site is unattributed:no-site');

ok(a['did:13175550100']!.site === 'North' && a['did:13175550100']!.how === 'via-user:100', 'a number routed to a user inherits that user\'s site');
ok(a['did:13175550101']!.site === 'North' && a['did:13175550101']!.how === 'via-user:701', 'a number routed to a system user with a site inherits that site, same as a real user');
ok(a['did:13175550106']!.site === null && a['did:13175550106']!.how === 'unattributed:routed-to:system-tod', 'a number routed to a site-less system user names its service code');
ok(a['did:13175550102']!.site === null && a['did:13175550102']!.how === 'unattributed:routed-to:to-connection', 'a number routed to a connection names the application');
ok(a['did:13175550103']!.site === null && a['did:13175550103']!.how === 'unattributed:no-site', 'a number routed to a site-less user is no-site, not routed-to');
ok(a['did:13175550104']!.site === null && a['did:13175550104']!.how === 'unattributed:routed-to:to-user', 'a number whose destination user does not exist falls back to the application name');

ok(a['addr:a-1']!.site === null && JSON.stringify(a['addr:a-1']!.sites) === JSON.stringify(['North', 'South']) && a['addr:a-1']!.how === 'via-users:100,101',
  'an address referenced from two sites carries BOTH, sorted, with no single site and no shared-across reason');
ok(a['addr:a-2']!.site === 'South' && JSON.stringify(a['addr:a-2']!.sites) === JSON.stringify(['South']) && a['addr:a-2']!.how === 'via-users:102', 'an address referenced from one site follows it and names the users');
ok(a['addr:a-3']!.site === null && a['addr:a-3']!.sites.length === 0 && a['addr:a-3']!.how === 'unattributed:unreferenced', 'an address nobody references is unreferenced');

// `sites` is the list form of `site` for every kind that has exactly one, so a consumer can read the
// one field and never branch on the kind.
ok(JSON.stringify(a['ext:100']!.sites) === JSON.stringify(['North']), 'an extension carries its own site as a one-entry list');
ok(a['ext:103']!.sites.length === 0, 'and a site-less one carries an empty list');
ok(JSON.stringify(a['did:13175550100']!.sites) === JSON.stringify(['North']), 'a number carries the site it inherited');
ok(a['did:13175550102']!.sites.length === 0, 'and an unattributed number carries none');
ok(JSON.stringify(a['sms:13175550100']!.sites) === JSON.stringify(['North']), 'an SMS number carries the site of the user it is enabled on');
ok(a['sms:13175550199']!.sites.length === 0, 'and an unknown one carries none');
ok(Object.values(a).every((v) => JSON.stringify(v.sites) === JSON.stringify([...new Set(v.sites)].sort())), 'every sites list is unique and sorted');
ok(Object.values(a).every((v) => (v.site === null ? true : v.sites.length === 1 && v.sites[0] === v.site)), 'a single site is exactly the one-entry list, and never disagrees with it');

// An address whose referencing users have no site at all: still unattributed, and the reason says why.
const noSiteAddr = attributeDomainInventory({
  ...snap,
  users: [{ user: '104', site: '', 'service-code': '', 'emergency-address-id': 'a-4' }],
  addresses: [{ 'emergency-address-id': 'a-4' }],
}).items;
ok(noSiteAddr['addr:a-4']!.how === 'unattributed:no-site' && noSiteAddr['addr:a-4']!.sites.length === 0,
  'an address whose referencing users have no site is no-site, with no sites to name');

ok(a['sms:13175550100']!.site === 'North' && a['sms:13175550100']!.how === 'via-user:100', 'an SMS number follows the user it is enabled on');
ok(a['sms:13175550102']!.site === null && a['sms:13175550102']!.how === 'unattributed:no-site', 'an SMS number on a site-less user is no-site');
ok(a['sms:13175550199']!.site === null && a['sms:13175550199']!.how === 'unattributed:sms-user-unknown', 'an SMS number no per-user list claims is sms-user-unknown');

// Without the per-user read at all, every SMS number is unknown — never guessed.
const noUser = attributeDomainInventory({ ...snap, smsNumbersByUser: undefined }).items;
ok(noUser['sms:13175550100']!.how === 'unattributed:sms-user-unknown', 'with no per-user SMS read, SMS numbers are sms-user-unknown');

// The address rule reads REAL extensions only: a queue referencing an address must not place it.
const queueAddr = attributeDomainInventory({ ...snap, users: [{ user: '701', site: 'North', 'service-code': 'system-queue', 'emergency-address-id': 'a-3' }], addresses: [{ 'emergency-address-id': 'a-3' }] }).items;
ok(queueAddr['addr:a-3']!.how === 'unattributed:unreferenced', 'a system user referencing an address does not attribute it');

// A number routed to a system user by an application other than to-user still names the service code.
const devRoute = attributeDomainInventory({ ...snap, phonenumbers: [{ phonenumber: '13175550105', 'dial-rule-application': 'to-single-device', 'dial-rule-translation-destination-user': '101' }] }).items;
ok(devRoute['did:13175550105']!.site === 'South' && devRoute['did:13175550105']!.how === 'via-user:101', 'to-single-device to a real user inherits the site like to-user');

// ── E911 endpoints, legacy numbers, and the two inheritances ────────────────────────────────────────
{
  // Two endpoints. One is bound to the DOMAIN DEFAULT address, so the users who set nothing land on it
  // — that inheritance is the whole reason a "nobody references this" verdict cannot be read off the
  // raw user records.
  const e: Snapshot = {
    meta: { domain: 'acme.example' },
    users: [
      { user: '100', site: 'North', 'service-code': '', 'emergency-address-id': 'a-1', 'caller-id-number-emergency': '3175550100' },
      { user: '101', site: 'South', 'service-code': '', 'emergency-address-id': 'a-1', 'caller-id-number-emergency': '13175550100' },
      { user: '102', site: 'South', 'service-code': '', 'emergency-address-id': 'a-2', 'caller-id-number-emergency': '3175550101' },
      { user: '103', site: 'North', 'service-code': '' },                                   // inherits both
      { user: '104', site: 'North', 'service-code': '' },                                   // device-set, below
      { user: '701', site: 'North', 'service-code': 'system-queue', 'caller-id-number-emergency': '3175550102' },
    ],
    devicesByUser: { '104': [{ device: 'sip:104@acme.example', 'caller-id-number-emergency': '3175550101' }] },
    addresses: [
      { 'emergency-address-id': 'a-1', 'address-name': 'HQ', domain_default: true },
      { 'emergency-address-id': 'a-2', 'address-name': 'Annex' },
      { 'emergency-address-id': 'a-3', 'address-name': 'Old dock' },
    ],
    addressEndpoints: [
      { 'emergency-address-id': '3175550100', 'address-name': 'HQ', 'caller-name': 'Acme HQ' },
      { 'emergency-address-id': '3175550101', 'address-name': 'Annex', 'caller-name': 'Acme Annex' },
      { 'emergency-address-id': '3175550102', 'address-name': 'Nobody', 'caller-name': 'Acme Nobody' },
    ],
  } as Snapshot;

  const at = attributeDomainInventory(e).items;
  const det = listDomainInventory(e);
  ok([...det.e911Endpoints, ...det.e911Legacy].every((i) => i.key in at), '[e911] every endpoint has an attribution');

  ok(at['e911:3175550100']!.site === null
    && JSON.stringify(at['e911:3175550100']!.sites) === JSON.stringify(['North', 'South'])
    && at['e911:3175550100']!.how === 'via-users:100,101,103',
    '[e911] the default endpoint carries both its explicit holders AND the user who inherited it');
  ok(at['e911:3175550101']!.site === null, '[e911] an endpoint two sites reference has no single site, same as an address');
  ok(JSON.stringify(at['e911:3175550101']!.sites) === JSON.stringify(['North', 'South'])
    && at['e911:3175550101']!.how === 'via-users:102,104',
    '[e911] a device-set caller ID references the endpoint exactly as a user-set one does');
  ok(at['e911:3175550102']!.how === 'unattributed:unreferenced' && at['e911:3175550102']!.sites.length === 0,
    '[e911] a system user referencing an endpoint does not attribute it');

  // The ADDRESS rule inherits too: a-1 is the domain default, so 103 and 104 reference it without
  // saying so, and a-3 is genuinely unreferenced.
  ok(at['addr:a-1']!.how === 'via-users:100,101,103,104', '[e911] a blank emergency-address-id resolves to the domain default before "unreferenced"');
  ok(at['addr:a-3']!.how === 'unattributed:unreferenced', '[e911] and an address nothing points at is still unreferenced');
}

{
  // A LEGACY domain: no endpoints, no addresses, two hand-set numbers. Placed like an endpoint.
  const l: Snapshot = {
    meta: { domain: 'demo.12345.service' },
    users: [
      { user: '100', site: 'North', 'service-code': '', 'caller-id-number-emergency': '3175550200' },
      { user: '101', site: 'South', 'service-code': '', 'caller-id-number-emergency': '3175550200' },
      { user: '102', site: 'South', 'service-code': '', 'caller-id-number-emergency': '3175550201' },
      { user: '103', site: '', 'service-code': '', 'caller-id-number-emergency': '3175550202' },
    ],
    // Endpoints READ, and there are none. Absent would mean the fetch never asked, and no legacy
    // number is derivable in that state — see `DomainInventory.e911Legacy`.
    addressEndpoints: [],
  } as Snapshot;
  const at = attributeDomainInventory(l).items;
  ok(at['e911legacy:3175550200']!.site === null
    && JSON.stringify(at['e911legacy:3175550200']!.sites) === JSON.stringify(['North', 'South'])
    && at['e911legacy:3175550200']!.how === 'via-users:100,101',
    '[legacy] a number two sites use carries both, like a shared address');
  ok(at['e911legacy:3175550201']!.site === 'South' && at['e911legacy:3175550201']!.how === 'via-users:102',
    '[legacy] and one site follows it');
  ok(at['e911legacy:3175550202']!.how === 'unattributed:no-site' && at['e911legacy:3175550202']!.sites.length === 0,
    '[legacy] a number whose only user has no site is no-site');
}


console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
