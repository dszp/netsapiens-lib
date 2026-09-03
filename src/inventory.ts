/**
 * Count a domain's inventory along the dimensions a VoIP operator actually sells on.
 *
 * Pure: it fetches nothing. Feed it a `Snapshot` — from `fetchDomainSnapshot`, a backup, or a
 * fixture — and it returns fixed, named counts and nothing else.
 *
 * ## Why counts and not records
 *
 * A device record from NetSapiens carries the SIP registration password. This function deliberately
 * returns only totals and model names, so a consumer that shows inventory to an operator cannot
 * accidentally show a credential. Nothing here returns a record, and nothing should be added that does.
 *
 * ## Every countable dimension is a numeric leaf
 *
 * A caller comparing this against a billing system addresses a dimension by dotted path —
 * `extensions.total`, `dids.tollFree`, `extensions.byServiceCode.premium`. Keeping every leaf numeric
 * is what makes that possible without this module knowing anything about the billing side.
 *
 * ## What counts as an extension
 *
 * A user whose `service-code` is empty or does not begin with `system-`. NetSapiens models auto
 * attendants, queues and time-of-day routers as users, and counting them as seats would overstate
 * every domain that has any. They are counted separately, as information, and never compared.
 */
import type { Rec, Snapshot } from './model.js';

export interface DomainInventory {
  /** Real seats: users whose `service-code` is empty or non-`system-*`. */
  extensions: {
    total: number;
    /** Keyed by the raw `user-scope` value, e.g. "Basic User". */
    byScope: Record<string, number>;
    /**
     * Keyed by the raw `service-code`, the empty string included — so a deployment that starts
     * tagging seat type into `service-code` needs no change here to be counted by it.
     */
    byServiceCode: Record<string, number>;
    /** Multi-device extensions are a real billing shape (a restaurant with four handsets on one seat). */
    byDeviceCount: Record<'0' | '1' | '2' | '3+', number>;
  };
  /** `system-aa`, `system-queue`, `system-tod` and any other `system-*` code. Informational. */
  systemUsers: { total: number; byServiceCode: Record<string, number> };
  /** Extensions whose `voicemail-transcription-enabled` is anything but empty or `no`. */
  transcriptionEnabled: number;
  /** Phone numbers on the domain, split by NANP toll-free prefix. */
  dids: { total: number; tollFree: number; local: number };
  /** E911 address records on the domain. */
  e911Addresses: number;
  /** SMS-enabled numbers on the domain. */
  smsNumbers: number;
  /** Devices belonging to real extensions only — a system user's device is not a seat. */
  devices: { total: number; byModel: Record<string, number> };
}

/** NANP toll-free area codes, 800 through 888. A number outside this set is counted local. */
const TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const bump = (into: Record<string, number>, key: string): void => { into[key] = (into[key] ?? 0) + 1; };

/** Is this user one of NetSapiens' internal routing objects rather than a seat? */
function isSystemUser(user: Rec): boolean {
  return str(user['service-code']).toLowerCase().startsWith('system-');
}

/**
 * Toll-free test on the digits alone. `+1 (800) 555-0102`, `18005550102` and `8005550102` all read as
 * toll-free; anything that is not a 10- or 11-digit NANP number is counted local rather than guessed at.
 */
function isTollFree(raw: string): boolean {
  const digits = raw.replace(/\D+/g, '');
  const nanp = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return nanp.length === 10 && TOLL_FREE.has(nanp.slice(0, 3));
}

export function countDomainInventory(snapshot: Snapshot): DomainInventory {
  const users: Rec[] = Array.isArray(snapshot.users) ? snapshot.users : [];
  const devicesByUser: Record<string, Rec[]> = (snapshot.devicesByUser ?? {}) as Record<string, Rec[]>;
  const phonenumbers: Rec[] = Array.isArray(snapshot.phonenumbers) ? snapshot.phonenumbers : [];
  const addresses: Rec[] = Array.isArray(snapshot.addresses) ? snapshot.addresses : [];
  const smsnumbers: Rec[] = Array.isArray(snapshot.smsnumbers) ? snapshot.smsnumbers : [];

  const inv: DomainInventory = {
    extensions: { total: 0, byScope: {}, byServiceCode: {}, byDeviceCount: { '0': 0, '1': 0, '2': 0, '3+': 0 } },
    systemUsers: { total: 0, byServiceCode: {} },
    transcriptionEnabled: 0,
    dids: { total: phonenumbers.length, tollFree: 0, local: 0 },
    e911Addresses: addresses.length,
    smsNumbers: smsnumbers.length,
    devices: { total: 0, byModel: {} },
  };

  for (const u of users) {
    const ext = str(u.user);
    if (isSystemUser(u)) {
      inv.systemUsers.total++;
      bump(inv.systemUsers.byServiceCode, str(u['service-code']));
      continue;
    }
    inv.extensions.total++;
    const scope = str(u['user-scope']);
    if (scope) bump(inv.extensions.byScope, scope);
    bump(inv.extensions.byServiceCode, str(u['service-code']));

    const transcription = str(u['voicemail-transcription-enabled']).toLowerCase();
    if (transcription !== '' && transcription !== 'no') inv.transcriptionEnabled++;

    const devices = ext ? (devicesByUser[ext] ?? []) : [];
    const bucket = devices.length >= 3 ? '3+' : (String(devices.length) as '0' | '1' | '2');
    inv.extensions.byDeviceCount[bucket]++;
    inv.devices.total += devices.length;
    // A device whose model is blank is counted under a named bucket rather than dropped: a missing
    // model is a provisioning gap worth seeing, and a silently smaller total hides it.
    for (const d of devices) bump(inv.devices.byModel, str(d['device-models-model']) || '(unknown)');
  }

  for (const p of phonenumbers) {
    if (isTollFree(str(p.phonenumber))) inv.dids.tollFree++;
    else inv.dids.local++;
  }

  return inv;
}
