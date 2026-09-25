// `@evalsuite/sandbox-docker`: a local Docker sandbox for AI SDK harnesses, with an egress gateway
// that brokers credentials and enforces a network policy.
export {
  buildDockerfile,
  buildImage,
  buildInstallLayer,
  contextFiles,
  DOCKER_CONTEXT,
  dockerfileTag,
  dockerignoreMatcher,
  ES_BASE_ARG,
  harnessImageFor,
  type InstallStep,
  installLayerTag,
  installScript,
} from './build-image.ts'
export {
  type DockerResult,
  docker,
  dockerAvailable,
  dockerCapacity,
  dockerOk,
  type ImageInfo,
  imageInfo,
  isRegistryDigest,
  removeContainerDetached,
} from './docker-cli.ts'
export { CA_PATH, PROXY_PORT } from './egress/gateway.ts'
export {
  defaultAllowedHosts,
  HARNESS_HOSTS,
  hostAllowed,
  type NetworkPolicy,
} from './egress/policy.ts'
export {
  applyTransformations,
  type EndpointMatch,
  matches,
  onEndpoint,
  type RequestTransformation,
} from './egress/rules.ts'
export type { SubstituteIn, Substitution } from './egress/substitution.ts'
export { type DerivedTokens, tokenPlaceholder } from './egress/tokens.ts'
export {
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
  SANDBOX_ROOT,
  WORKSPACE_DIR,
} from './image.ts'
export {
  createDockerSession,
  type DockerSession,
  dockerSandboxProvider,
  type EgressOptions,
  type EgressStatus,
  type SessionOptions,
} from './session.ts'
