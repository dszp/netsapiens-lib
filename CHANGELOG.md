# Changelog

All notable changes to `@dszp/netsapiens-lib` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — 2026-07-17

### Added

- **`NsWriteClient` — the write surface this library was planned to grow.** A separate class over a
  private fetch transport (`post`/`put`/`delete`, injecting `synchronous: 'yes'` so a create returns the
  created resource inline instead of a 202), with typed device methods (`getDevices`, `getDevice`,
  `createDevice`, `deleteDevice`). The read-only `NsClient` charter is untouched: reads and writes are two
  classes, so a consumer that only wants to read holds `NsClient` and has no write method to call. Both
  share the `assertBareServer` SSRF guard. Offline tests use a recording mock fetch.

### Changed

- **`NsApiError` gains an optional trailing `method`** (set by the write client, unset for reads). Purely
  additive — existing `(message, status, path, body)` call sites are unchanged.

## [0.1.2] — 2026-07-16

A security-hardening release. Every item below hardens the library **as a dependency in someone
else's app** — none is exploitable through this project's own Worker (which passes only hex accents,
fronts a single NS core, and doesn't reach the vulnerable paths), but a consumer who wired the library
up differently could be. No breaking changes to the documented API.

### Security

- **`accent` is now validated, not trusted.** `renderGalleryHtml`'s `accent` was interpolated into a
  `<style>` block raw — no escaping, no validation — while every value beside it was escaped. A host
  that sourced it per-tenant (which the doc comment invited: *"pass your own brand color… from your
  host's config"*) handed any tenant who could set an accent a `</style><script>` breakout against
  every other viewer. Non-hex values are now ignored in favour of the theme's link color.
- **`escapeHtml` now escapes quotes** (`"`, `'`). It was used in attribute position
  (`<script src="${escapeHtml(url)}">`) but escaped only `& < >`, so `mermaidSrc: 'x.js" onload="…'`
  injected an attribute. The escaping *looked* applied, which is worse than none.
- **`MemoryVerdictCache` is now bounded** (1000-entry FIFO, expired entries swept on insert). Entries
  expired only lazily on a `get()` for that same key, so an attacker sending each token once never
  triggered a sweep. A negative verdict is cached for tokens anyone can mint (correct `aud`/`iss`/`exp`
  need no signing key), so an unbounded map was a remote OOM of the isolate.
- **The verdict cache key now includes the `server`.** `verify()` keyed the cache on the token hash
  alone, so a consumer fronting two NS cores with one shared cache could be served a token validated
  against server A as `ok` for a request bound to server B (B never contacted). The key is now
  `SHA-256(server + NUL + token)`. `tokenKey(token, server?)` gained the optional argument.
- **`server` is validated as a bare host** in both `NsClient` and `verify()`. A consumer that derived
  `server` from request input would otherwise let `api.example.com@evil.example` or `evil.example#…`
  redirect the Bearer token off-origin. New exported `assertBareServer(server)`.
- **`nbf` (not-before) is now enforced.** A token dated in the future passed every local check and
  still cost an upstream `/jwt` roundtrip; `verify(…, {mode:'format', signingSecret})` even returned
  `ok:true` for it. Rejected locally now, with a 60s clock-skew leeway.
- **The read-only clients are private at runtime, not just in TypeScript.** `RingotelReadClient`'s
  transport and `NsClient`'s token were TS-`private` (erased at runtime), so the fleet API key / bearer
  token were reachable via `(client as any).http` / `.token`. They are ECMAScript `#private` now, so
  the read-only-capability guarantee the docs make actually holds when a client is handed to a
  less-trusted module.
- **`flowAnchorId` sanitizes `entity.kind`**, not just `entity.ref` — `resolveFlow` emits only four
  literal kinds so nothing it produces changes, but a hand-built `FlowGraph` can no longer put an
  unescaped string into `id="…"` / `href="#…"`.
- **The super-user scope is matched by synonym.** `can()`/policy matching now treats `Super User`,
  `superuser`, and `super-user` as one scope, closing a fail-closed lockout where a core emitting one
  spelling was denied by a policy written with another.

### Fixed

- **`NsApiError.message` is bounded to 500 chars on both branches.** The object branch previously
  `JSON.stringify`'d the whole upstream body unbounded, so a consumer logging `err.message` could log
  an arbitrarily large NS response.
- **Published `dist/` no longer points at source maps that were never shipped.** Every `.js`/`.d.ts`
  carried a `//# sourceMappingURL` comment while `files` excludes the maps, so consumers' devtools
  404'd. The publish build emits no pointer; a normal `pnpm build` still writes maps for `link:` consumers.
- **A prerelease can no longer be published as `latest`.** The release workflow derives npm's dist-tag
  from the version — prerelease ⇒ `next`, else `latest`.
- **`require()` gives an accurate error, or works.** Added `require`/`default` export conditions, so
  `require('@dszp/netsapiens-lib')` works on Node ≥22.12 (`require(esm)`) and reports `ERR_REQUIRE_ESM`
  on older Node instead of the misleading `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Documentation

- README said "three capabilities" and omitted two shipped since 0.1.0: the principal/policy engine
  (`toPrincipal` / `can` / `isAllowed`) and the `THEMES` registry.
- Doc-comments pointing at absent files (`cli.ts`, a gitignored `CLAUDE.md`) and an internal tool name
  now read generically. These ship in `dist/*.d.ts` and surface on a consumer's IDE hover.

## [0.1.1] — 2026-07-16

### Fixed

- **`package.json` is now exported.** `exports` restricted the subpath map to `.`, so any consumer or
  tool reading `@dszp/netsapiens-lib/package.json` — bundlers, version checks, some test runners — hit
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. Added the conventional `"./package.json": "./package.json"`.

### Notes

- First release published by CI via **OIDC trusted publishing**, so this is the first version to carry
  a **provenance attestation**. (`0.1.0` was published by hand out of necessity: npm can only attach a
  trusted publisher to a package that already exists.)

## [0.1.0] — 2026-07-15

Initial public release.

### Added

- **`NsClient` + `fetchDomainSnapshot`** — read-only NetSapiens API v2 client. `get()` is the entire
  surface, by charter.
- **`verify` / `validateJwtFormat` / `assertClaims`** — `ns_t` validation with a pluggable
  `VerdictCache`, a cheap local gate before any roundtrip, and `forceFresh` for the revocation window.
- **`resolveFlow` / `listEntities`** — deterministic domain snapshot → normalized `FlowGraph`.
- **`toMermaid`, `renderGalleryHtml`, `renderFlowCards`, `rasterizerScript`** — renderers that return
  strings; the caller picks the sink.
- **`THEMES`** — a vendor-neutral theme registry (node palettes + Mermaid base/look + app chrome) as
  plain data.
- **`toPrincipal` / `can` / `isAllowed`** — masking-aware identity normalization and a declarative,
  fail-closed policy engine.

### Notes

- **Zero runtime dependencies. Node-free**: the same built output runs unchanged in a Cloudflare
  Worker, in Node, and in the browser. `tsconfig` sets `types: []` and omits `@types/node`, so a stray
  `node:*` import fails the build.
- **Nothing is bound to a particular deployment.** `NsClient` requires `server`; `verify()` requires
  `expectedIss` (one host or a list, exact match) unless you opt out with `validateIss: false`, and
  fails closed when neither is given. Only `aud` has a default (`"ns"`), because the platform fixes it
  for everyone.
- **`verify()` cannot check the signature locally.** `ns_t` is HS256 with a core-held secret and no
  public JWKS, so the live `GET /jwt` call is the signature and revocation authority; `mode: 'format'`
  never means "authenticated" without a `signingSecret`. See ARCHITECTURE.md.

[Unreleased]: https://github.com/dszp/netsapiens-lib/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/dszp/netsapiens-lib/releases/tag/v0.1.2
[0.1.1]: https://github.com/dszp/netsapiens-lib/releases/tag/v0.1.1
[0.1.0]: https://github.com/dszp/netsapiens-lib/releases/tag/v0.1.0
