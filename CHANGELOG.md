# Changelog

All notable changes to `@dszp/netsapiens-lib` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-09-04

### Added

- **`listDomainInventory(snapshot)`** — the per-item lists behind `countDomainInventory`'s counts:
  extensions and system users (`ExtensionItem`), phone numbers (`NumberItem`), E911 addresses
  (`AddressItem`) and SMS numbers (`SmsItem`), each with a stable `key` (`ext:100`, `did:13175550100`,
  `addr:a-1`, `sms:13175550100`). Pure, same allowlist discipline as the counts: name, site and device
  *models* are carried; a device's MAC, SIP credentials and email never are.
- **`itemsFor(detail, path)`** — the items behind one of `countDomainInventory`'s dotted-path counts
  (`extensions.total`, `extensions.byScope.<scope>`, `extensions.byServiceCode.<code>`,
  `extensions.byDeviceCount.<0|1|2|3+>`, `extensions.withAnyDevice`, `extensions.withNoDevice`,
  `transcriptionEnabled`, `teamsConnected`, `dids.total`, `dids.tollFree`, `dids.local`,
  `e911Addresses`, `smsNumbers`). Returns `undefined` — not `[]` — for a dimension with no item list
  (`devices.*`, `systemUsers.*`) or an unrecognized path.
- **`itemLabel(item)`** — one display line for any `InventoryItem`, for an operator-facing accept/reject
  list.
- **`teamsConnected`** on `DomainInventory` and `teams` on `ExtensionItem` — an extension with a
  Microsoft Teams connector device (SIP `aor` local part `<ext>t`). That connector device is excluded
  from `devices`/`deviceCount`: it is a connector, not a handset.
- **`anyDevice`** on `ExtensionItem`, and **`extensions.withAnyDevice`** / **`extensions.withNoDevice`**
  on `DomainInventory` — whether an extension has a device of any kind (`deviceCount > 0 || teams`:
  handset or Teams connector, either counts). Some operators bill on device presence alone regardless of
  count or connector type, so it is its own countable dimension rather than something a caller derives
  from `byDeviceCount` and `teamsConnected`. `itemsFor` answers both new paths; the two leaves partition
  `extensions.total`.

### Changed

- **`countDomainInventory` is now a fold over `listDomainInventory`'s lists** — same output shape and
  values as before, plus `teamsConnected`, and the two can no longer disagree because one is derived
  from the other.
- Lists carry names and sites by design, unlike the counts — that is the point of a per-item list — but
  still never a MAC or a SIP credential.

## [0.2.0] — 2026-09-03

### Added

- **`countDomainInventory(snapshot)`** — counts a domain along the dimensions an operator sells on:
  extensions (by scope, by service code, by device count), system users, transcription-enabled seats,
  phone numbers split local/toll-free, E911 addresses, SMS numbers, and devices by model. Pure: it
  reads a `Snapshot` and fetches nothing.

  It returns **counts and model names only, never device records** — a NetSapiens device record carries
  the SIP registration password, and an inventory view is exactly the kind of screen that would leak one.

- **Three optional reads on `fetchDomainSnapshot`**: `includeAddresses`, `includeSmsNumbers` and
  `includeDevices`, filling `snapshot.addresses`, `snapshot.smsnumbers` and `snapshot.devicesByUser`.
  All three default to false, so a routing caller pays nothing for them.

  `includeSmsNumbers` sends `?dest=*`. The endpoint is documented as taking no parameters, and a live
  server answers 400 without `dest` or `number`.

  `includeDevices` costs one call per real extension — NetSapiens has no domain-level device list —
  and skips `system-*` users, which hold no seat.

## [0.1.9] — 2026-08-12

### Changed

- **`notUsers` now also matches the operator behind a mask.** Previously it tested only the effective
  identity, so a denied account regained the capability simply by masquerading into another account —
  the denial evaporated exactly when someone went looking for a way around it.

  This is the one place this engine is deliberately asymmetric, and the asymmetry is the point. Every
  positive condition sees the **effective** principal, so a grant follows the role currently being
  performed; masquerading is full impersonation and is meant to be. A denial is not about a role. It
  names a person, and a denial that does not survive that person impersonating someone else is not a
  denial. So `notUsers` asks both "who is acting" and "who is behind this", and refuses if either is
  named.

  Nothing else changes: a principal with no operator is judged on its own id, as before, and denying an
  account that is not behind any mask behaves identically.

  ⚠️ This **narrows** existing policies rather than widening them, so it cannot grant anyone anything
  they did not already have. If you deny an account that legitimately performs work while masquerading,
  that work is now refused — which is the intended reading of a denial, but worth knowing before
  upgrading. `notUsers` shipped one day earlier in 0.1.8; nothing should yet depend on the old
  behaviour.

## [0.1.8] — 2026-08-11

### Added

- **`PolicyRule.notUsers` — the engine's one negative condition.** A rule may now name accounts it
  excludes: `{ scopes: ['Reseller'], notUsers: ['105@acme.example'] }` admits every reseller except that
  account. It ANDs with the rest of the rule, like every other condition, so it narrows the rule it sits
  on.

  It exists because the positive form cannot express "everyone at this scope except these accounts"
  without enumerating the complement — the list of accounts that *keep* the capability — which is wrong
  the moment an account is created, and wrong silently. Naming the exception stays correct as accounts
  come and go, because the scope side is evaluated from each caller's own token rather than from a list
  anyone maintains.

  Two properties worth knowing before you use it:

  - **It does not count as a condition of its own.** A rule carrying only `notUsers` never matches.
    "Everybody except X" as a standalone rule would be an allow-all wearing an exception, and this
    engine's shape is that a rule says who it admits before it says who it does not. Pair it with
    `scopes`, `domains` or `users`.
  - **It is per-rule, not per-policy.** Rules are OR'd, so a policy compiled from a "deny this account"
    intent must carry the negation on *every* rule it emits; one bare rule re-admits the account through
    it. The selftest pins this so a consumer distributing a denial can rely on the semantics rather than
    rediscovering them.

  Additive and optional — existing policies are unaffected.

## [0.1.7] — 2026-08-04

### Changed

- **`synchronous: 'yes'` is now injected only on the operations that accept it.** `NsWriteClient`
  previously added the flag to *every* POST and PUT, and its doc comment promised "200 + the created
  resource inline" for all of them. That promise was only ever true for a minority of endpoints:
  `synchronous` is a **per-operation** capability, declared by exactly **17 operations** in the v2
  spec (core 44.4.10) and almost all of them creates. Sending it elsewhere is inert — NetSapiens
  ignores unrecognized body fields and still answers `202 Accepted` — so the code merely *looked*
  as though its writes were confirmed.

  The new `supportsSynchronous(method, path)` and the `SYNCHRONOUS_OPERATIONS` table are exported,
  so other NetSapiens clients can share one answer instead of each keeping its own drifting copy.

  **What changes in practice:** `createDevice` (`POST .../devices`) still sends the flag and still
  returns the created device with its generated SIP password inline. `updateDevice`
  (`PUT .../devices/{device}`) no longer sends it, because that operation never accepted it; its
  response was already a bare 202 acknowledgement, and `ensureNsDevice` already falls back to the
  password it just set rather than trusting an echo. No caller behaviour should change — this
  removes a field the API was discarding.

  The absence worth knowing is **`PUT /domains/{domain}/users/{user}`**: a user *update* cannot be
  made synchronous, though a user *create* can. Verified live 2026-08-03 — the flag in the body, as
  `?synchronous=yes`, as `?synchronous=true`, both, and omitted all return an identical 202. Confirm
  a user update by reading the record back; there is no response that can confirm it for you.

## [0.1.6] — 2026-07-27

### Added

- **Event Subscriptions — `NsSubscriptionsClient`, plus a pure reconciliation planner.** NetSapiens can
  POST change events to a URL you own; this is the client for managing those subscriptions and the logic
  for keeping them correct. It is a **separate class on purpose**: `NsClient` is read-only by charter, and
  `NsWriteClient` is unsuitable here for two concrete reasons — it injects `synchronous: 'yes'` into every
  write, and its `delete()` sends no body, while `DELETE /subscriptions/{id}` *requires* one
  (`subscription_id`, plus `domain` below Super User scope).

  `planSubscriptions()` is pure — no I/O, no clock — so the whole decision surface is testable and
  shareable. It only ever acts on subscriptions whose `post-url` matches a prefix you own; anything else on
  the same domain is reported, never modified. Also exported: `SUBSCRIPTION_MODELS` (the 11-value enum,
  for validating config before it reaches the API), `isSubscriptionModel`, and `nsDatetime` /
  `parseNsDatetime`.

  Four API behaviours worth knowing, all observed against a live 44.4.x core and **not** what the published
  spec says:

  * **Always send an explicit `expiresAt`.** It is honoured verbatim *even when the request is
    authenticated with a one-hour OAuth access token* — the expiry is not clamped to the credential's
    lifetime. Omitting it makes the subscription's lifetime depend on how you authenticated (an API key
    yields ~20 years; a timed token yields that token's expiry).
  * **`subscription-geo-support` behaves as `no` when omitted**, though the spec documents the default as
    `yes`. Send it explicitly or delivery is pinned to one node and stops when that node is down.
  * **Datetimes are asymmetric.** Reads return ISO-8601 with an offset; the documented *write* format is
    `YYYY-MM-DD HH:MM:SS`. `parseNsDatetime` accepts both, `nsDatetime` emits the documented form, and a
    bare timestamp is read as UTC.
  * **`error-count > 0` is normal on a healthy subscription** — one live example sat at 7 errors across
    7,195 posts while `status` stayed `active`. Treat `status === 'error'` or a sustained error *rate* as
    the signal, and do not reset the counters as routine maintenance: they are the only history the API
    keeps.

  Note also that the domain-scoped routes (`/domains/{domain}/subscriptions`, v45+) are **absent on a v44
  core**, which answers `404 No Route Found`. The flat methods are the portable ones; treat the
  domain-scoped variants as an opt-in optimization.

- **`ensureNsDevice` — device orchestration, with optional SIP password rotation.** Ensures a named device
  exists and returns its SIP registration password: read it back with a per-device GET when present
  (a device *list* may omit the password), create it when absent, or refuse to create with
  `mayCreate: false`.

  `rotateExisting` replaces the password of a device that **already existed**, and it closes a failure that
  is genuinely hard to diagnose: reusing the stored password leaves any *other* endpoint still holding it
  with valid credentials for the same address-of-record. Both clients then register, the most recent wins,
  and they trade the registration back and forth — intermittent call failures with nothing obviously wrong
  in either system. Rotate only where something has just declared the device to belong to one client (a
  deliberate activation, or a first-time provision); **not** on a per-login path, where concurrent runs
  would churn the credential and can race a re-registration.

  Rotation is **best-effort and never throws**: on failure the result carries the pre-existing password
  plus `rotated: false` and `rotateError`, because failing the whole operation over a hardening step would
  be worse than the contention it prevents. A core without the device `PUT` lands there.

  Also exported: `generateSipPassword` (alphanumeric only — the value passes through SIP digest auth and
  provisioning templates, where punctuation buys no real entropy and risks an escaping bug; characters are
  rejection-sampled rather than modulo-reduced, and at least one uppercase, one lowercase and one digit are
  guaranteed), `SIP_PW_FIELD`, and the structural `NsDeviceWriter`.

- **`NsWriteClient.updateDevice()`**, and a convenience `NsWriteClient.ensureDevice()`.
  `updateDevice` exists so a password can be rotated **in place**: deleting and recreating the device would
  discard everything else on it — emergency caller id, the provisioning MAC/model link, SRTP and transport
  settings. `ensureDevice()` is a deliberate one-line delegation to `ensureNsDevice` so the capability is
  discoverable from a client you already hold; the logic stays a standalone function because every other
  method on that class is exactly one HTTP request, and because a consumer with its own write client can
  still use it.

### Fixed

- **Auto-attendant second-level menus ("Add Tier") now render as menus, not as a dead-end prompt.** A
  keypress that opens a nested tier appears in the dialplan as `Prompt_<menu>.Case_N → Prompt <tierId>`,
  which is indistinguishable from a plain play-a-prompt option unless you notice that `Prompt_<tierId>.`
  rules also exist. The resolver drew "🔊 Play prompt \<id\>" and stopped, hiding the entire submenu. It
  now recurses into the tier with the same grammar, taking the tier's script text from the
  `/autoattendants` detail's `option-N.auto-attendant` — the two endpoints each hold half of a tier (the
  dialplan has the id but not the nesting, the detail has the nesting but no id) and join only on the
  keypress digit. Recursion is unbounded, since the dialplan grammar is; a tier keyed back to an earlier
  menu draws the existing loops-back leaf. "Repeat greeting" nodes are now per-tier, so a submenu's
  timeout no longer collapses onto the top menu's.

- **A played message is no longer drawn as a dead end.** An `Announce` keypress is followed by an
  `Announce_<id>.Done` rule saying where the call goes when the message finishes — almost always back to
  the menu. That rule was never read, so every message node terminated the flow. It is now followed;
  a return to the same menu reuses the shared "Repeat greeting" node, since it is the same behavior as
  the no-key default.

## [0.1.5] — 2026-07-22

### Added

- **`evaluateEligibility` can waive the email precondition, and says when it did.** The precondition
  exists because activation typically *emails* credentials — but on an SSO/JIT path the account is created
  from the user's own directory credentials at first sign-in and nothing is mailed, so requiring an address
  there wrongly rejects eligible users. Set `EligContext.emailNotRequired` on those paths. It waives
  **only** the email precondition — never HARD, never SOFT. The caller still decides *when* to set it; the
  engine only guarantees the outcome is identical everywhere it is.

  A waived result stays distinguishable: `EligResult.emailWaived` is `true` (and the missing address is
  stated in `reasons`) while `tier` is `'ok'`. So a caller can still branch on "eligible, but there is no
  address to mail anything to" — previously the only way to know that was to re-implement the waiver
  outside the engine, which is exactly the duplication this removes.

  Additive and backward-compatible: omit `emailNotRequired` and behavior is unchanged; `emailWaived` is
  absent unless a waiver actually happened.

## [0.1.4] — 2026-07-19

### Added

- **`NsAuthClient` — the NetSapiens OAuth2 password-grant surface.** Node-free, two jobs off one call:
  `verifyCredentials(username, password)` confirms an end user's credentials (the check an external SSO
  webhook needs), and `passwordGrant(...)` mints an access token for a reseller/admin user — an alternative
  to a static API key for the write client. Fail-closed by contract: a 4xx means "bad credentials"
  (`{ ok: false }`), while a 5xx or network error **rethrows**, so a caller can't mistake an upstream outage
  for a failed login. `ok` is true **if and only if** a non-empty `access_token` was issued (NetSapiens can
  answer `200` with an in-band error body). Reuses the `assertBareServer` SSRF guard; adds `NsAuthError`.
- **`evaluateEligibility` — a generic, deployment-neutral predicate** answering "is this NetSapiens user a
  real end-user candidate?" for any app integration. Pure; precedence is HARD (system/service users, i.e. a
  non-blank service code, and structurally-invalid extensions — never overridable) → SOFT (name matchers,
  extension lists, a no-device heuristic that only *tightens* a name match; overridable per configured
  category, or by an explicit per-request force) → an email precondition → ok. Consumers supply an
  `EligibilityConfig`; env parsing stays in the consumer.

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
