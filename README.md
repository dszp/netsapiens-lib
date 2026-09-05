# @dszp/netsapiens-lib

Portable, **Node-free** NetSapiens toolkit. The same code runs unchanged in a Cloudflare Worker, in
Node, or in the browser — it uses only Web APIs (`fetch`, `atob`, `TextDecoder`, `crypto.subtle`),
never `node:*`.

Five capabilities, one dependency-free package:

- **NS API v2 client (read + write)** — `NsClient` (read-only: `get()` + `fetchDomainSnapshot(client,
  domain)` which assembles a routing-relevant domain snapshot) plus `NsWriteClient`, a **separate** write
  client (device provisioning). Both are bearer-auth with an injectable `fetch`; holding the read client
  still cannot write.
- **JWT (`ns_t`) validation** — `verify()` (cheap local format gate → cached live `/jwt` check) and
  `validateJwtFormat()`. Pluggable `VerdictCache` (inject the Workers Cache API / KV / DO;
  `MemoryVerdictCache` for dev). Anti-overload by design — a bad/expired token never hits the server.
- **Call-flow resolver + renderers** — `resolveFlow(snapshot, ref)` walks a NetSapiens domain snapshot
  into a normalized `FlowGraph`; `toMermaid()` renders it to a Mermaid flowchart; `renderGalleryHtml()`
  / `renderFlowCards()` return HTML strings the caller can place anywhere.
- **Identity + policy** — `toPrincipal()` normalizes a validated token into an effective identity
  (masking-aware: the effective user is the masked one, the `operator` is the reseller behind a
  `mask_chain`), and `can()` / `isAllowed()` gate features against it with a declarative,
  **fail-closed** policy. So "who is this, and may they?" isn't re-invented per consumer.
- **Themes** — `THEMES`, a vendor-neutral registry (node palettes + Mermaid base/look + app chrome)
  as plain data. Add one here and every host picks it up; nothing is bound to one deployment's brand.

## Install

```
npm install @dszp/netsapiens-lib      # or: pnpm add / yarn add
```

ESM-only, zero runtime dependencies, ships its own types.

## Usage

```ts
import { resolveFlow, toMermaid, renderGalleryHtml, verify, NsClient } from '@dszp/netsapiens-lib';

const graph = resolveFlow(snapshot, { kind: 'did', ref: '13175550100' });
const mermaid = toMermaid(graph);
const html = renderGalleryHtml(snapshot.meta.domain, [graph]);
```

### What `NsClient` covers

`NsClient` is deliberately **not** an enumeration of endpoints — it has exactly one method:

```ts
client.get<T>(path, query?)   // any GET under https://{server}/ns-api/v2
```

That's the whole surface. Any v2 read is reachable (`/domains`, `/domains/{d}/users`,
`/domains/{d}/users/{ext}/devices`, …) without this library needing to know about it, and one choke
point is what makes the read-only property below checkable rather than a promise. NetSapiens versions
drift; consult your server's own `/ns-api/apidoc/` for the paths it offers.

Two composites are provided because they're multi-read and worth getting right once:

| Function | Reads |
|---|---|
| `listDomains(client)` | `/domains` → `{domain, description, locked}[]` |
| `fetchDomainSnapshot(client, domain, opts?)` | `/domains/{d}` plus, in parallel, `timeframes`, `users`, `callqueues`, `phonenumbers`, `autoattendants` — then per-user `answerrules`. Individual reads fail **soft** (a missing collection yields `[]`, not a thrown snapshot). |

The snapshot is the routing subset — what `resolveFlow()` needs. It is not a full domain export. Three
options pull in more, each off by default because each costs an extra read: `includeAddresses` (E911
address records), `includeSmsNumbers` (SMS-enabled numbers), and `includeDevices` (per-extension device
records — one `/devices` read per real extension, so it is the expensive one on a domain with many seats).
All three exist for `countDomainInventory()` below; a caller that only resolves call flows never needs them.

A per-extension devices read that fails with anything other than 404 does not abort the snapshot — the
extension stays in `users` with no entry in `devicesByUser`, and its number is recorded in
`snapshot.deviceReadFailures` instead. `deviceReadFailures` is set whenever `includeDevices` was asked
for (an empty array when nothing failed) and absent otherwise, so a device-count consumer can tell a
genuine zero from a read that never completed rather than silently undercounting.

### Counting a domain: `countDomainInventory`

`countDomainInventory(snapshot)` is pure — it fetches nothing, and turns a `Snapshot` (from
`fetchDomainSnapshot`, a backup, or a fixture) into a fixed tree of numeric leaves along the dimensions a
VoIP operator actually sells on:

- `extensions` — real seats (users whose `service-code` is empty or not `system-*`), by `total`, by
  `byScope` (raw `user-scope`), by `byServiceCode`, by `byDeviceCount` (`'0' | '1' | '2' | '3+'`), and by
  device presence: `withAnyDevice` / `withNoDevice` (`anyDevice = deviceCount > 0 || teams` — a handset
  or a Teams connector, either counts; the two partition `total`).
- `systemUsers` — `system-aa`, `system-queue`, `system-tod` and friends: `total` and `byServiceCode`.
  Informational, never compared against a seat count.
- `transcriptionEnabled` — extensions with voicemail transcription on.
- `teamsConnected` — extensions with a Microsoft Teams connector device (SIP `aor` local part
  `<ext>t`). That connector is excluded from `devices`/`deviceCount`: it is a connector, not a handset.
- `dids` — phone numbers, `total` / `tollFree` / `local`.
- `e911Addresses`, `smsNumbers` — record counts.
- `devices` — `total` and `byModel`, real extensions only (a system user's device is not a seat).

Every leaf is a number, on purpose: a caller reconciling this against a billing system addresses a
dimension by dotted path (`extensions.total`, `dids.tollFree`) without this module knowing anything
about the billing side. It also **never returns a device record** — a NetSapiens device carries the SIP
registration password, so returning totals and model names only means a consumer showing inventory to
an operator cannot accidentally show a credential.

For a complete count, fetch the snapshot with all three extra options — `dids`, `e911Addresses`,
`smsNumbers` and `devices` all read as zero against a snapshot that omitted them:

```ts
import { fetchDomainSnapshot, countDomainInventory } from '@dszp/netsapiens-lib';

const snapshot = await fetchDomainSnapshot(client, 'acme.example', {
  includeAddresses: true, includeSmsNumbers: true, includeDevices: true,
});
const inventory = countDomainInventory(snapshot);
inventory.dids.tollFree;      // e.g. 3
inventory.devices.byModel;    // e.g. { "Yealink T54W": 12, "(unknown)": 1 }
```

#### Listing a domain: `listDomainInventory`

`countDomainInventory` is a fold over `listDomainInventory(snapshot)`, which returns the per-item lists
behind those counts — for anything that shows an operator *which* extension or number a count refers to,
not just how many. Same allowlist discipline as the counts: a device's MAC, SIP credentials and email
never appear, though names and sites now do (that's the point of a list). Each item carries a stable
`key`:

| List | Item key |
|---|---|
| `extensions`, `systemUsers` | `ext:<user>` |
| `dids` | `did:<phonenumber>` |
| `e911Addresses` | `addr:<emergency-address-id>` |
| `smsNumbers` | `sms:<number>` |

`itemsFor(detail, path)` returns the items behind one of `countDomainInventory`'s dotted-path counts —
the same vocabulary, so a UI that lets an operator drill from a count into the records behind it needs
no separate lookup table:

| Path | Items |
|---|---|
| `extensions.total` | every extension |
| `extensions.byScope.<scope>` | extensions with that `user-scope` |
| `extensions.byServiceCode.<code>` | extensions with that `service-code` (`extensions.byServiceCode.` selects the empty code) |
| `extensions.byDeviceCount.<0\|1\|2\|3+>` | extensions in that device-count bucket |
| `extensions.withAnyDevice` / `extensions.withNoDevice` | extensions with / without any device (handset or Teams connector) |
| `transcriptionEnabled` | extensions with transcription on |
| `teamsConnected` | extensions with a Teams connector |
| `dids.total` / `dids.tollFree` / `dids.local` | phone numbers |
| `e911Addresses` | E911 addresses |
| `smsNumbers` | SMS numbers |

`devices.*` and `systemUsers.*` paths return `undefined` — not `[]` — because there is no item list for
them (devices aren't compared individually; system users are informational, never compared). An
unrecognized path also returns `undefined`. `itemLabel(item)` gives one display line for any item, for
an operator-facing accept/reject list:

```ts
import { listDomainInventory, itemsFor, itemLabel } from '@dszp/netsapiens-lib';

const detail = listDomainInventory(snapshot);
const premium = itemsFor(detail, 'extensions.byServiceCode.premium') ?? [];
premium.map(itemLabel); // e.g. ["101 — Jane Doe, North", "102"]
```

### Read/write split by charter

`NsClient` exposes **`get()` and nothing else**, and `verify()` only ever issues `GET /jwt`. That is a
deliberate boundary, not a missing feature: this library is built for tools that visualize and audit a
NetSapiens domain, where "it cannot possibly write" is a property worth having structurally rather
than by convention. Writes live in a **separate** class — `NsWriteClient`, a small, explicitly-reviewed
surface (device provisioning) — never as new methods on `NsClient`. So a consumer that holds the read
client still cannot write; that guarantee holds by construction, not by convention.

### Which writes actually confirm: `synchronous`

`synchronous: 'yes'` asks the API to finish the write before replying, so you get **200 with the
resulting resource inline** — including server-generated fields you could not otherwise learn without a
second read, a new device's SIP registration password being the worked example. Without it you get
**202 Accepted** and a bare `{code, message}`.

It is a **per-operation capability, not a global one**: exactly 17 operations declare it in the v2
specification (core 44.4.10), and almost all of them are creates. Sending it anywhere else is inert —
NetSapiens ignores unrecognized body fields and still answers 202 — so code that adds it everywhere
merely *looks* as though its writes are confirmed.

`NsWriteClient` therefore injects the flag only where it is accepted, and exports the table so other
NetSapiens clients can share one answer instead of each keeping a copy that drifts:

```ts
import { supportsSynchronous, SYNCHRONOUS_OPERATIONS } from '@dszp/netsapiens-lib';

supportsSynchronous('POST', '/domains/acme.example/users');     // true  — user CREATE
supportsSynchronous('PUT',  '/domains/acme.example/users/100'); // false — user UPDATE
```

`path` is the concrete request path relative to `/ns-api/v2`, dynamic segments already URI-encoded.
The most consequential absence is that **user update** is not on the list even though user create is:
there is no response that can confirm a user update, so confirm it by reading the record back.

### Configuration binds to *your* deployment

Two values are required and have no defaults, on purpose — a default would silently bind you to
someone else's portal:

- `NsClient({ server })` — your NS API host, e.g. `api.example.com`.
- `verify(token, { expectedIss })` — the Manager Portal host that issues your `ns_t`, e.g.
  `manage.example.com`. Pass an array when one backend is fronted by several portal hostnames
  (exact match, no wildcards), or `validateIss: false` to opt out deliberately.

`aud` defaults to `"ns"` because that value is fixed by the NetSapiens platform and true for everyone.

## Develop

```
pnpm install
pnpm build          # tsc → dist/
pnpm test           # the offline suite — green with no credentials, no setup
```

The build (`tsconfig.json`) omits `@types/node` on purpose: a stray `node:*` import fails the build,
which is how the Node-free guarantee is enforced.

`pnpm test:ns <snapshot.json>` is separate and not part of `pnpm test`: it needs a real domain
snapshot, which is customer data and correctly absent from this repo.

## Docs

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — module boundaries, why the live `/jwt` call is the
  signature authority, the Mermaid rendering traps, and the NetSapiens routing model the resolver
  decodes.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — the rules: fictional fixtures, no deployment-binding
  defaults, doc comments are published API, Node-free.
- **[CHANGELOG.md](./CHANGELOG.md)**

## License

[MIT](./LICENSE) © David Szpunar
