/**
 * Public API of the portable call-flow library — the surface any host imports (Cloudflare
 * Worker, an onboarding CLI / review page / build-preview, the portal viewer). Everything
 * re-exported here is Node-free and runtime-portable; any Node-only host code (e.g. a CLI) lives
 * outside this surface.
 *
 * Typical use in another project:
 *   import { resolveFlow, toMermaid, renderGalleryHtml, verify } from '@dszp/netsapiens-lib';
 *   const graph = resolveFlow(snapshot, { kind: 'did', ref: '13175550100' });
 *   const html  = renderGalleryHtml(snapshot.meta.domain, [graph]);
 */

export type { FlowGraph, FlowNode, FlowEdge, NodeKind, EdgeKind, Snapshot, Rec } from './model.js';
export { resolveFlow, listEntities, type EntityRef } from './resolver.js';
export { toMermaid, type FlowTheme, type MermaidOptions } from './mermaid.js';
export {
  THEMES,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
  NODE_LIGHT,
  NODE_DARK,
  NODE_SLATE,
  NODE_A11Y,
  type ThemeDef,
  type ThemeChrome,
  type ThemeMode,
  type NodePalette,
} from './themes.js';
export {
  renderGalleryHtml,
  renderFlowCards,
  renderFlowCard,
  mermaidBootstrap,
  flowAnchorId,
  type GalleryOptions,
  type CardOptions,
} from './html.js';
export { resolveSvgSize, rasterizerScript } from './raster.js';
export { NsClient, NsApiError, assertBareServer, fetchDomainSnapshot, listDomains, asArray, type NsClientConfig, type FetchSnapshotOptions } from './nsClient.js';
export { countDomainInventory, countInventoryDetail, listDomainInventory, itemsFor, itemLabel, destinationOf, usersByExt, type DomainInventory, type DomainInventoryDetail, type InventoryOptions, type ExtensionItem, type NumberItem, type AddressItem, type SmsItem, type InventoryItem } from './inventory.js';
export { attributeDomainInventory, type DomainAttribution, type ItemAttribution } from './attribution.js';
export { NsWriteClient, type NsWriteClientConfig } from './nsWriteClient.js';
export {
  supportsSynchronous,
  SYNCHRONOUS_OPERATIONS,
  type SynchronousMethod,
  type SynchronousOperation,
} from './nsSynchronous.js';
export {
  ensureNsDevice,
  generateSipPassword,
  SIP_PW_FIELD,
  type NsDeviceWriter,
  type EnsureNsDeviceOptions,
  type EnsureNsDeviceResult,
} from './nsDevice.js';
export { NsAuthClient, NsAuthError, type NsAuthClientConfig, type NsTokenResponse } from './nsAuthClient.js';
export {
  NsSubscriptionsClient,
  NsSubscriptionConflictError,
  SUBSCRIPTION_MODELS,
  isSubscriptionModel,
  nsDatetime,
  parseNsDatetime,
  subscriptionFromWire,
  createInputToWire,
  updateInputToWire,
  planSubscriptions,
  type SubscriptionModel,
  type SubscriptionStatus,
  type Subscription,
  type CreateSubscriptionInput,
  type UpdateSubscriptionInput,
  type NsSubscriptionsClientConfig,
  type DesiredSubscription,
  type SubscriptionAction,
  type PlanSubscriptionsOptions,
} from './nsSubscriptions.js';
export {
  verify,
  validateJwtFormat,
  extractContext,
  assertClaims,
  verifyHs256Signature,
  normalizeToken,
  tokenKey,
  MemoryVerdictCache,
  type JwtVerdict,
  type JwtContext,
  type ClaimExpectations,
  type VerdictCache,
  type VerifyOptions,
  type FormatResult,
} from './jwt.js';
export { type CallSensitivity, needsFreshAuth, SENSITIVITY_NOTE } from './sensitivity.js';
export {
  toPrincipal,
  parseOperator,
  isResellerScope,
  isAdminScope,
  type Principal,
  type Operator,
  type Scope,
} from './principal.js';
export {
  ruleMatches,
  isAllowed,
  can,
  type PolicyRule,
  type Policy,
  type FeaturePolicies,
} from './policy.js';
export {
  evaluateEligibility,
  type SoftCategory,
  type EligibilityConfig,
  type EligUser,
  type EligContext,
  type EligTier,
  type EligResult,
} from './eligibility.js';
