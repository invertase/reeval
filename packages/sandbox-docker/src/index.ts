// `@evalsuite/sandbox-docker`: a local Docker sandbox for AI SDK harnesses.
export {
  buildEnvironmentLayer,
  buildImage,
  DOCKER_CONTEXT,
  environmentLayerTag,
  harnessImageFor,
} from './build-image.ts'
export {
  type DockerResult,
  docker,
  dockerAvailable,
  dockerCapacity,
  dockerOk,
  type ImageInfo,
  imageInfo,
  removeContainerDetached,
} from './docker-cli.ts'
export {
  BASE_IMAGE,
  BRIDGE_PORT,
  DEFAULT_IMAGE,
  HARNESS_CURSOR_VERSION,
  LABEL,
  SANDBOX_ROOT,
  WORKSPACE_DIR,
} from './image.ts'
export { createDockerSession, dockerSandboxProvider } from './session.ts'
