#!/bin/bash
# WebSync - Multi-platform Docker build and push
#
# Usage:
#   ./scripts/docker-build.sh              # Build + push both platforms (default)
#   ./scripts/docker-build.sh build        # Build both platforms (no push)
#   ./scripts/docker-build.sh push         # Build + push both platforms
#   ./scripts/docker-build.sh build amd64  # Build amd64 only (load to local)
#   ./scripts/docker-build.sh build arm64  # Build arm64 only (load to local)
#
# Environment:
#   IMAGE     - Full image name (e.g. youruser/websync). Default: websync
#   TAG       - Image tag. Default: latest
#   DOCKER_HUB_IMAGE - Overrides IMAGE if set (from .env)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# Load .env if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Image config (from .env: DOCKER_HUB_IMAGE, WEBSYNC_VERSION)
IMAGE="${IMAGE:-${DOCKER_HUB_IMAGE:-websync}}"
TAG="${TAG:-${WEBSYNC_VERSION:-latest}}"
FULL_IMAGE="${IMAGE}:${TAG}"

# Docker Hub requires username/repo format (e.g. youruser/websync)
validate_image() {
  if [[ "$1" == "push" ]] && [[ "$IMAGE" != */* ]]; then
    echo -e "${RED}Error: Docker Hub requires your username in the image name.${NC}"
    echo ""
    echo "Set DOCKER_HUB_IMAGE in .env to your Docker Hub repo, e.g.:"
    echo "  DOCKER_HUB_IMAGE=your-dockerhub-username/websync"
    echo ""
    echo "Or run: IMAGE=your-dockerhub-username/websync $0 push"
    exit 1
  fi
}

# Platforms
PLATFORMS="linux/amd64,linux/arm64"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
  echo "WebSync Docker Build"
  echo ""
  echo "Usage: $0 [command] [platform]"
  echo ""
  echo "Commands:"
  echo "  build [amd64|arm64]  Build image(s). Omit platform for both (build cache only)."
  echo "  push                 Build and push both amd64 + arm64 to registry"
  echo "  (default)            Same as 'push'"
  echo ""
  echo "Examples:"
  echo "  $0                    # Build + push both platforms"
  echo "  $0 push               # Same as above"
  echo "  $0 build              # Build both (for CI/cache)"
  echo "  $0 build amd64        # Build amd64 only, load locally"
  echo "  $0 build arm64       # Build arm64 only, load locally"
  echo ""
  echo "Environment: IMAGE=${IMAGE:-<not set>} TAG=$TAG"
  echo ""
  echo "For push: set DOCKER_HUB_IMAGE=youruser/websync in .env"
}

ensure_buildx() {
  if ! docker buildx version &>/dev/null; then
    echo -e "${RED}Error: docker buildx is required. Install Docker Buildx.${NC}"
    exit 1
  fi

  # Create multi-platform builder if needed (docker-container driver required for multi-arch)
  if ! docker buildx inspect websync-builder &>/dev/null; then
    echo -e "${YELLOW}Creating buildx builder 'websync-builder' (docker-container driver)...${NC}"
    docker buildx create --name websync-builder --driver docker-container --use
  else
    docker buildx use websync-builder
  fi
}

cmd_build() {
  local platform="$1"
  ensure_buildx

  if [ -z "$platform" ]; then
    echo -e "${GREEN}Building for ${PLATFORMS} (no load)${NC}"
    docker buildx build \
      --platform "$PLATFORMS" \
      -t "$FULL_IMAGE" \
      --progress=plain \
      .
  elif [ "$platform" = "amd64" ]; then
    echo -e "${GREEN}Building linux/amd64 (loading to local)${NC}"
    docker buildx build \
      --platform linux/amd64 \
      -t "$FULL_IMAGE" \
      --load \
      .
  elif [ "$platform" = "arm64" ]; then
    echo -e "${GREEN}Building linux/arm64 (loading to local)${NC}"
    docker buildx build \
      --platform linux/arm64 \
      -t "$FULL_IMAGE" \
      --load \
      .
  else
    echo -e "${RED}Unknown platform: $platform. Use amd64 or arm64.${NC}"
    exit 1
  fi
}

cmd_push() {
  validate_image push
  ensure_buildx
  echo -e "${GREEN}Building and pushing ${FULL_IMAGE} for ${PLATFORMS}${NC}"
  docker buildx build \
    --platform "$PLATFORMS" \
    -t "$FULL_IMAGE" \
    --push \
    .
  echo -e "${GREEN}Done. Pushed ${FULL_IMAGE}${NC}"
}

# Parse command
CMD="${1:-push}"
PLATFORM="${2:-}"

case "$CMD" in
  build)
    cmd_build "$PLATFORM"
    ;;
  push)
    cmd_push
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo -e "${RED}Unknown command: $CMD${NC}"
    usage
    exit 1
    ;;
esac
