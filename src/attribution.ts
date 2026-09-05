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
 * - A number: the site of its `dial-rule-translation-destination-user` when that names a user WITH a
 *   site (`via-user:<ext>`) — real or system, whatever the application (`to-user`, `to-single-device`);
 *   a queue at the North site is a North number. Only a site-less system user falls back to
 *   `routed-to:<that user's service-code>`; when the destination names nobody, `routed-to:<application>`;
 *   a site-less real user is `no-site`.
 * - An address: EVERY site a REAL extension referencing it sits on (`via-users:<exts>`), in `sites`.
 *   An address is a fact about a PLACE, and users on four sites can legitimately reference one — so
 *   the multi-site case is not a failure to attribute, it is the answer. `site` is the single site
 *   when there is exactly one and `null` otherwise, so a consumer that can only hold one still reads
 *   the unambiguous case correctly. `unreferenced` when no real extension names it; `no-site` when the
 *   ones that do have no site.
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
import { isSystemUser, listDomainInventory, str, usersByExt } from './inventory.js';
import type { Rec, Snapshot } from './model.js';

export interface ItemAttribution {
  /**
   * The single site this item belongs to; `null` when there is not exactly one — nothing placed it, or
   * (addresses only) several did. Read {@link sites} to tell those two apart.
   */
  site: string | null;
  /**
   * EVERY site this item belongs to, unique and sorted. One entry wherever {@link site} is set, none
   * where nothing placed it, and — for an address referenced from several sites — one per site.
   *
   * The wider field, and the one a consumer splitting a domain between accounts should read: only an
   * ADDRESS can carry more than one, because only an address is a fact about a place rather than about
   * a user, a number or a route.
   */
  sites: string[];
  /** `own-site` | `via-user:<ext>` | `via-users:<ext,ext>` | `unattributed:<reason>`. */
  how: string;
}
export interface DomainAttribution { items: Record<string, ItemAttribution> }

const none = (reason: string): ItemAttribution => ({ site: null, sites: [], how: `unattributed:${reason}` });

export function attributeDomainInventory(snapshot: Snapshot): DomainAttribution {
  const users: Rec[] = Array.isArray(snapshot.users) ? snapshot.users : [];
  const phonenumbers: Rec[] = Array.isArray(snapshot.phonenumbers) ? snapshot.phonenumbers : [];
  const addresses: Rec[] = Array.isArray(snapshot.addresses) ? snapshot.addresses : [];
  const smsnumbers: Rec[] = Array.isArray(snapshot.smsnumbers) ? snapshot.smsnumbers : [];
  const byUser = snapshot.smsNumbersByUser;
  const d = listDomainInventory(snapshot);
  const items: Record<string, ItemAttribution> = {};

  const userByExt = usersByExt(users);
  /** The single-site verdict, with `sites` kept in step so the two fields can never disagree. */
  const one = (site: string, how: string): ItemAttribution => ({ site, sites: [site], how });

  // Extensions: the detail already carries `site`, so no record is needed here.
  for (const x of d.extensions) items[x.key] = x.site ? one(x.site, 'own-site') : none('no-site');

  // Numbers, by index against `phonenumbers`.
  for (let i = 0; i < d.dids.length; i++) {
    const key = d.dids[i]!.key, p = phonenumbers[i] ?? {};
    const app = str(p['dial-rule-application']) || 'unknown';
    const dest = str(p['dial-rule-translation-destination-user']);
    const u = dest ? userByExt.get(dest) : undefined;
    if (!u) { items[key] = none(`routed-to:${app}`); continue; }
    const site = str(u.site);
    if (!site) { items[key] = isSystemUser(u) ? none(`routed-to:${str(u['service-code'])}`) : none('no-site'); continue; }
    items[key] = one(site, `via-user:${dest}`);
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
    if (sites.length === 0) { items[key] = none('no-site'); continue; }
    // SEVERAL SITES IS AN ANSWER, not a failure. The referencing users name every place this address
    // is used, and a consumer billing per site needs all of them; `site` still answers only the
    // unambiguous case, which is what keeps a one-site consumer correct without reading `sites`.
    const how = `via-users:${who.map((u) => str(u.user)).filter(Boolean).sort().join(',')}`;
    items[key] = sites.length === 1 ? one(sites[0]!, how) : { site: null, sites, how };
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
    items[key] = site ? one(site, `via-user:${ext}`) : none('no-site');
  }

  return { items };
}
