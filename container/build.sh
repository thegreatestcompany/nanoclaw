#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# Prune dangling build cache layers superseded by this build.
# Keeps the current image's active cache for incremental rebuilds,
# removes orphaned layers from previous builds. Prevents the 40+ GB
# accumulation observed in the 2026-04-08 incident.
${CONTAINER_RUNTIME} builder prune -f --filter "until=24h" >/dev/null 2>&1 || true
# Remove dangling images (old layers not referenced by any tag).
${CONTAINER_RUNTIME} image prune -f >/dev/null 2>&1 || true

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
