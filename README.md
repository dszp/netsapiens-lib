# @dszp/netsapiens-lib

Portable, **Node-free** NetSapiens toolkit. The same code runs unchanged in a Cloudflare Worker, in
Node, or in the browser — it uses only Web APIs (`fetch`, `atob`, `TextDecoder`, `crypto.subtle`),
never `node:*`.

Five capabilities, one dependency-free package:

- **Read-only NS API v2 client** — `NsClient` (bearer auth, injectable `fetch`) +
  `fetchDomainSnapshot(client, domain)` which assembles a routing-relevant domain snapshot.
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

The snapshot is the routing subset — what `resolveFlow()` needs. It is not a full domain export.

### Read-only by charter

`NsClient` exposes **`get()` and nothing else**, and `verify()` only ever issues `GET /jwt`. That is a
deliberate boundary, not a missing feature: this library is built for tools that visualize and audit a
NetSapiens domain, where "it cannot possibly write" is a property worth having structurally rather
than by convention. Writes belong in a separate, explicitly-reviewed client. If a write surface is
added here later it will be a distinct class, never new methods on `NsClient`.

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
