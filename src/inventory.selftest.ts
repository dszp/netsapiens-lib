/** Offline test for the domain inventory counter. pnpm test:inventory */
import { countDomainInventory } from './inventory.js';
import type { Snapshot } from './model.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

const snap: Snapshot = {
  meta: { domain: 'acme.example' },
  users: [
    { user: '100', 'user-scope': 'Basic User', 'service-code': '', 'voicemail-transcription-enabled': 'no' },
    { user: '101', 'user-scope': 'Basic User', 'service-code': 'premium', 'voicemail-transcription-enabled': 'yes' },
    { user: '102', 'user-scope': 'Office Manager', 'service-code': 'premium', 'voicemail-transcription-enabled': 'voicebase' },
    { user: '103', 'user-scope': 'Basic User', 'service-code': '' },
    { user: '700', 'user-scope': 'Basic User', 'service-code': 'system-aa' },
    { user: '701', 'user-scope': 'Basic User', 'service-code': 'system-queue' },
    { user: '702', 'user-scope': 'Basic User', 'service-code': 'system-tod' },
  ],
  devicesByUser: {
    '100': [{ aor: 'sip:100@acme.example', 'device-models-model': 'Yealink T54W' }],
    '101': [
      { aor: 'sip:101a@acme.example', 'device-models-model': 'Yealink T54W' },
      { aor: 'sip:101b@acme.example', 'device-models-model': 'Yealink T31P' },
      { aor: 'sip:101c@acme.example', 'device-models-model': '' },
    ],
    '102': [{ aor: 'sip:102@acme.example', 'device-models-model': 'Yealink T31P' }],
  },
  phonenumbers: [
    { phonenumber: '13175550100' }, { phonenumber: '13175550101' },
    { phonenumber: '18005550102' }, { phonenumber: '18335550103' },
  ],
  addresses: [{ 'address-id': '1' }, { 'address-id': '2' }],
  smsnumbers: [{ number: '13175550100' }],
} as Snapshot;

const inv = countDomainInventory(snap);

ok(inv.extensions.total === 4, 'four real extensions — the three system-* users are not extensions');
ok(inv.extensions.byScope['Basic User'] === 3, 'three Basic User extensions');
ok(inv.extensions.byScope['Office Manager'] === 1, 'one Office Manager extension');
ok(inv.extensions.byScope['system-aa'] === undefined, 'byScope never carries a system user');
ok(inv.extensions.byServiceCode[''] === 2, 'the empty service code is a key, not a dropped bucket');
ok(inv.extensions.byServiceCode['premium'] === 2, 'two premium-coded extensions');
ok(inv.extensions.byDeviceCount['0'] === 1, 'one extension with no device');
ok(inv.extensions.byDeviceCount['1'] === 2, 'two extensions with one device');
ok(inv.extensions.byDeviceCount['2'] === 0, 'none with exactly two');
ok(inv.extensions.byDeviceCount['3+'] === 1, 'one extension with three devices lands in 3+');
ok(inv.systemUsers.total === 3, 'three system users');
ok(inv.systemUsers.byServiceCode['system-aa'] === 1, 'one auto attendant');
ok(inv.systemUsers.byServiceCode['system-queue'] === 1, 'one queue');
ok(inv.systemUsers.byServiceCode['system-tod'] === 1, 'one time-of-day');
ok(inv.transcriptionEnabled === 2, 'yes and a provider name both count; no and absent do not');
ok(inv.dids.total === 4, 'four phone numbers');
ok(inv.dids.tollFree === 2, '800 and 833 are toll-free');
ok(inv.dids.local === 2, 'and the rest are local');
ok(inv.e911Addresses === 2, 'two address records');
ok(inv.smsNumbers === 1, 'one SMS number');
ok(inv.devices.total === 5, 'five devices across all extensions');
ok(inv.devices.byModel['Yealink T54W'] === 2, 'two T54W');
ok(inv.devices.byModel['Yealink T31P'] === 2, 'two T31P');
ok(inv.devices.byModel['(unknown)'] === 1, 'a device with no model is counted under (unknown), never dropped');

// An empty snapshot must answer zeros, not throw — a domain can genuinely have nothing.
const empty = countDomainInventory({ meta: { domain: 'empty.example' } } as Snapshot);
ok(empty.extensions.total === 0, 'empty snapshot: no extensions');
ok(empty.dids.total === 0 && empty.dids.tollFree === 0 && empty.dids.local === 0, 'empty snapshot: no numbers');
ok(empty.devices.total === 0, 'empty snapshot: no devices');
ok(empty.smsNumbers === 0 && empty.e911Addresses === 0, 'empty snapshot: no addresses and no SMS numbers');

// Devices belonging to a system user are not counted: they are not seats and never appear on a bill.
const sysDev = countDomainInventory({
  meta: { domain: 'sys.example' },
  users: [{ user: '700', 'service-code': 'system-aa' }],
  devicesByUser: { '700': [{ aor: 'sip:700@sys.example', 'device-models-model': 'Yealink T54W' }] },
} as Snapshot);
ok(sysDev.devices.total === 0, 'a system user device is not counted');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
