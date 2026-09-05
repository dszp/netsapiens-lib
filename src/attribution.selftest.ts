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
  ],
  phonenumbers: [
    { phonenumber: '13175550100', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '100' },
    { phonenumber: '13175550101', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '701' },
    { phonenumber: '13175550102', 'dial-rule-application': 'to-connection', 'dial-rule-translation-destination-user': '' },
    { phonenumber: '13175550103', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '103' },
    { phonenumber: '13175550104', 'dial-rule-application': 'to-user', 'dial-rule-translation-destination-user': '999' },
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
ok(a['did:13175550101']!.site === null && a['did:13175550101']!.how === 'unattributed:routed-to:system-queue', 'a number routed to a queue names the queue\'s service code');
ok(a['did:13175550102']!.site === null && a['did:13175550102']!.how === 'unattributed:routed-to:to-connection', 'a number routed to a connection names the application');
ok(a['did:13175550103']!.site === null && a['did:13175550103']!.how === 'unattributed:no-site', 'a number routed to a site-less user is no-site, not routed-to');
ok(a['did:13175550104']!.site === null && a['did:13175550104']!.how === 'unattributed:routed-to:to-user', 'a number whose destination user does not exist falls back to the application name');

ok(a['addr:a-1']!.site === null && a['addr:a-1']!.how === 'unattributed:shared-across:North,South', 'an address referenced from two sites is shared, sites sorted');
ok(a['addr:a-2']!.site === 'South' && a['addr:a-2']!.how === 'via-users:102', 'an address referenced from one site follows it and names the users');
ok(a['addr:a-3']!.site === null && a['addr:a-3']!.how === 'unattributed:unreferenced', 'an address nobody references is unreferenced');

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
