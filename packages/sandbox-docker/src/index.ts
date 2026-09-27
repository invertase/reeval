// `@evalsuite/sandbox-docker`: a local Docker sandbox for AI SDK harnesses, with an egress gateway
// that brokers credentials and enforces a network policy.
export {
  causeLine,
  type FailureCause,
  failureCause,
  ImageBuildError,
  type ImageFailure,
  type ImageStage,
  isTransient,
  parseBuildOutput,
  RETRY_DELAYS,
  retryTransient,
} from './build-failure.ts'
export {
  type BuildOutput,
  buildDockerfile,
  buildImage,
  buildInstallLayer,
  contextFiles,
  contextHash,
  DOCKER_CONTEXT,
  dockerfileTag,
  dockerignoreMatcher,
  ES_BASE_ARG,
  harnessImageFor,
  type InstallStep,
  installLayerTag,
  installScript,
  pruneImages,
  resolveFrom,
  usesEsBase,
} from './build-image.ts'
export {
  type DockerResult,
  type DockerState,
  docker,
  dockerAvailable,
  dockerCapacity,
  dockerOk,
  dockerState,
  type ImageInfo,
  imageInfo,
  isRegistryDigest,
  removeContainerDetached,
} from './docker-cli.ts'
export { CA_PATH, PROXY_PORT } from './egress/gateway.ts'
export {
  DOCKER_EGRESS,
  defaultAllowedHosts,
  type EgressCapabilities,
  HARNESS_HOSTS,
  hostAllowed,
  type NetworkPolicy,
  PACKAGE_HOSTS,
} from './egress/policy.ts'
export type {
  BlockedHost,
  ContactedHost,
  EgressEvent,
  EgressRequestEvent,
  EgressTraffic,
} from './egress/proxy.ts'
export {
  applyTransformations,
  type EndpointMatch,
  matches,
  onEndpoint,
  type RequestTransformation,
} from './egress/rules.ts'
export { placeholder, type SubstituteIn, type Substitution } from './egress/substitution.ts'
export type { DerivedTokens } from './egress/tokens.ts'
export {
  adapterVersion,
  BAKED_HARNESSES,
  BASE_IMAGE,
  type BakedHarness,
  BRIDGE_PORT,
  DEFAULT_IMAGE,
  HARNESS_PACKAGES,
  harnessLabel,
  imageFor,
  isBakedHarness,
  LABEL,
  SANDBOX_HOME,
  SANDBOX_ROOT,
  SANDBOX_USER,
  WORKSPACE_DIR,
} from './image.ts'
export {
  createDockerSession,
  DEFAULT_LIMITS,
  type DockerSession,
  dockerSandboxProvider,
  type EgressOptions,
  type EgressStatus,
  ROOT_CAPABILITIES,
  type SandboxLimits,
  type SessionOptions,
} from './session.ts'
export { type DockerCommand, onDockerCommand } from './trace.ts'
