/**
 * Which SITE each inventory item belongs to, and how that was decided. Pure: feed it the same
 * `Snapshot` `listDomainInventory` takes, get one verdict per item key.
 *
 * ## Why a library concern
 *
 * A NetSapiens domain can be billed in pieces — one account per site, or one account for most of
 * it and another for one branch — and the phone system already knows most of what is needed to
 * split it: a user carries `site`, a number carries its destination user, an SMS number is enabled
 * on a user, an address is referenced by users. What it does NOT know is who pays; that stays with
 * the consumer. This module answers "which site", never "which account".
 *
 * ## The rules
 *
 * - An extension: its own `site` (`own-site`), or `unattributed:no-site` when blank.
 * - A number: the site of its `dial-rule-translation-destination-user` when that names a REAL
 *   extension (`via-user:<ext>`), whatever the application — `to-user`, `to-single-device`. When it
 *   names a system user (a queue, an attendant, a time-of-day router are users too) the reason is
 *   `routed-to:<that user's service-code>`; when it names nobody, `routed-to:<application>`; a real
 *   user with no site is `no-site`.
 * - An address: the one site every REAL extension referencing it sits on (`via-users:<exts>`);
 *   `shared-across:<sites>` when they sit on more than one; `unreferenced` when none does;
 *   `no-site` when the referencing users have no site.
 * - An SMS number: the site of the user whose per-user list carries it (`via-user:<ext>`), or
 *   `sms-user-unknown` when no per-user list does — including when the per-user read was never
 *   made. Never guessed from the domain-level list, which does not say.
 *
 * ## Keys are joined by index
 *
 * `listDomainInventory` maps each source array 1:1 and in order, and this module relies on that to
 * put an item's KEY (which may be a derived `~hash`) beside its RECORD's routing fields. That
 * invariant is this library's own, and this is the one place allowed to lean on it.
 */
import { isSystemUser, listDomainInventory, str } from './inventory.js';
import type { Rec, Snapshot } from './model.js';

export interface ItemAttribution {
  /** The site this item belongs to; `null` when it cannot be placed. */
  site: string | null;
  /** `own-site` | `via-user:<ext>` | `via-users:<ext,ext>` | `unattributed:<reason>`. */
  how: string;
}
export interface DomainAttribution { items: Record<string, ItemAttribution> }

const none = (reason: string): ItemAttribution => ({ site: null, how: `unattributed:${reason}` });

export function attributeDomainInventory(snapshot: Snapshot): DomainAttribution {
  const users: Rec[] = Array.isArray(snapshot.users) ? snapshot.users : [];
  const phonenumbers: Rec[] = Array.isArray(snapshot.phonenumbers) ? snapshot.phonenumbers : [];
  const addresses: Rec[] = Array.isArray(snapshot.addresses) ? snapshot.addresses : [];
  const smsnumbers: Rec[] = Array.isArray(snapshot.smsnumbers) ? snapshot.smsnumbers : [];
  const byUser = snapshot.smsNumbersByUser;
  const d = listDomainInventory(snapshot);
  const items: Record<string, ItemAttribution> = {};

  const userByExt = new Map<string, Rec>();
  for (const u of users) { const ext = str(u.user); if (ext && !userByExt.has(ext)) userByExt.set(ext, u); }

  // Extensions: the detail already carries `site`, so no record is needed here.
  for (const x of d.extensions) items[x.key] = x.site ? { site: x.site, how: 'own-site' } : none('no-site');

  // Numbers, by index against `phonenumbers`.
  for (let i = 0; i < d.dids.length; i++) {
    const key = d.dids[i]!.key, p = phonenumbers[i] ?? {};
    const app = str(p['dial-rule-application']) || 'unknown';
    const dest = str(p['dial-rule-translation-destination-user']);
    const u = dest ? userByExt.get(dest) : undefined;
    if (!u) { items[key] = none(`routed-to:${app}`); continue; }
    if (isSystemUser(u)) { items[key] = none(`routed-to:${str(u['service-code'])}`); continue; }
    const site = str(u.site);
    items[key] = site ? { site, how: `via-user:${dest}` } : none('no-site');
  }

  // Addresses, by index against `addresses`; referenced by REAL extensions only.
  const refs = new Map<string, Rec[]>();
  for (const u of users) {
    if (isSystemUser(u)) continue;
    const id = str(u['emergency-address-id']);
    if (!id) continue;
    const list = refs.get(id) ?? []; list.push(u); refs.set(id, list);
  }
  for (let i = 0; i < d.e911Addresses.length; i++) {
    const key = d.e911Addresses[i]!.key, id = str((addresses[i] ?? {})['emergency-address-id']);
    const who = id ? refs.get(id) ?? [] : [];
    if (!who.length) { items[key] = none('unreferenced'); continue; }
    const sites = [...new Set(who.map((u) => str(u.site)).filter(Boolean))].sort();
    if (sites.length === 0) items[key] = none('no-site');
    else if (sites.length === 1) items[key] = { site: sites[0]!, how: `via-users:${who.map((u) => str(u.user)).filter(Boolean).sort().join(',')}` };
    else items[key] = none(`shared-across:${sites.join(',')}`);
  }

  // SMS numbers, by index against `smsnumbers`, joined to a user through the per-user lists.
  const extBySms = new Map<string, string>();
  if (byUser) for (const [ext, list] of Object.entries(byUser)) for (const s of Array.isArray(list) ? list : []) { const n = str(s.number); if (n && !extBySms.has(n)) extBySms.set(n, ext); }
  for (let i = 0; i < d.smsNumbers.length; i++) {
    const key = d.smsNumbers[i]!.key, n = str((smsnumbers[i] ?? {}).number);
    const ext = n ? extBySms.get(n) : undefined;
    const u = ext ? userByExt.get(ext) : undefined;
    if (!u) { items[key] = none('sms-user-unknown'); continue; }
    const site = str(u.site);
    items[key] = site ? { site, how: `via-user:${ext}` } : none('no-site');
  }

  return { items };
}
