// kxco-pq-network — the verification modes, and the registry behind them.
//
// This is the boundary between what is free and what is sold. The maths lives
// upstream in kxco-post-quantum and kxco-verify: Apache-2.0, chain-agnostic,
// works offline, no server. What lives here is the answer to whether a key is
// still allowed to sign, which is a fact about the present that no offline
// check can supply.
//
// Depended on by kxco-pq-sdk, kxco-pq-attest, kxco-post-quantum-webhook and
// kxco-pq-agent. It is its own package rather than a module inside the SDK
// because the SDK already depends on kxco-pq-attest, and putting it there
// would make that cycle.

export {
  networkConfig,
  networkConfigFromEnv,
  CHAIN_ID,
  VERIFY_MODES,
  DEFAULT_REGISTRY_URL,
  DEFAULT_RELAY_URL,
  DEFAULT_REGISTRY_TTL_MS,
} from './config.js'

export { KeyRegistry, KID_STATUS } from './registry.js'
export { applyVerifyMode, readAnchor } from './verify-mode.js'
export { KxcoPqNetworkError, FAILURE } from './errors.js'
export { meter, usageEvent, licencePrefix, EVENTS } from './meter.js'
