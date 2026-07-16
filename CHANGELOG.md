# Changelog

All notable changes to `@dszp/netsapiens-lib` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/dszp/netsapiens-lib/releases/tag/v0.1.0
