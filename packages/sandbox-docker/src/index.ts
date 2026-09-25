// `@evalsuite/sandbox-docker`: a local Docker sandbox for AI SDK harnesses, with an egress gateway
// that brokers credentials and enforces a network policy.
export {
  buildEnvironmentLayer,
  buildImage,
  DOCKER_CONTEXT,
  environmentLayerTag,
  harnessImageFor,
  type LayerStep,
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
  CURSOR_HOSTS,
  DEFAULT_ALLOWED_HOSTS,
  hostAllowed,
  type NetworkPolicy,
} from './egress/policy.ts'
export { applyTransformations, matches, type RequestTransformation } from './egress/rules.ts'
export {
  BASE_IMAGE,
  BRIDGE_PORT,
  DEFAULT_IMAGE,
  HARNESS_CURSOR_VERSION,
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
