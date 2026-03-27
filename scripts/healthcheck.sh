#!/bin/bash
# =============================================================================
# HNTIC Assistant — Healthcheck
# =============================================================================
# Usage: ./scripts/healthcheck.sh
#
# Vérifie que tous les composants fonctionnent. Utilisable en cron pour
# le monitoring ou manuellement pour diagnostiquer un problème.
# =============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATUS=0

check() {
  local name="$1"
  local result="$2"
  if [ "$result" = "ok" ]; then
    printf "  ✓ %-25s OK\n" "$name"
  else
    printf "  ✗ %-25s FAIL — %s\n" "$name" "$result"
    STATUS=1
  fi
}

echo "HNTIC Healthcheck — $(date '+%Y-%m-%d %H:%M')"
echo ""

# Process NanoClaw
if pgrep -f "node.*dist/index.js\|tsx.*src/index.ts" >/dev/null 2>&1; then
  check "NanoClaw process" "ok"
else
  check "NanoClaw process" "not running"
fi

# Credential proxy
if curl -s http://localhost:3001 >/dev/null 2>&1; then
  check "Credential proxy" "ok"
else
  check "Credential proxy" "port 3001 not responding"
fi

# Docker
if docker info >/dev/null 2>&1; then
  check "Docker" "ok"
else
  check "Docker" "not running"
fi

# Container image
if docker image inspect nanoclaw-agent:latest >/dev/null 2>&1; then
  check "Container image" "ok"
else
  check "Container image" "nanoclaw-agent:latest not found"
fi

# WhatsApp auth
if [ -f "$PROJECT_DIR/store/auth/creds.json" ]; then
  check "WhatsApp auth" "ok"
else
  check "WhatsApp auth" "store/auth/creds.json missing"
fi

# Business DB
if [ -f "$PROJECT_DIR/groups/main/business.db" ]; then
  TABLES=$(sqlite3 "$PROJECT_DIR/groups/main/business.db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table'" 2>/dev/null || echo "0")
  if [ "$TABLES" -gt 20 ]; then
    check "Business DB" "ok"
  else
    check "Business DB" "only $TABLES tables (expected 22+)"
  fi
else
  check "Business DB" "groups/main/business.db missing"
fi

# .env credentials
if grep -q "ANTHROPIC_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" "$PROJECT_DIR/.env" 2>/dev/null; then
  check "API credentials" "ok"
else
  check "API credentials" "no API key or OAuth token in .env"
fi

# Recent logs (activity in last hour)
if [ -f "$PROJECT_DIR/logs/nanoclaw.log" ]; then
  RECENT=$(find "$PROJECT_DIR/logs/nanoclaw.log" -mmin -60 2>/dev/null | wc -l)
  if [ "$RECENT" -gt 0 ]; then
    check "Recent activity" "ok"
  else
    check "Recent activity" "no log activity in last hour"
  fi
else
  check "Recent activity" "no log file"
fi

echo ""
if [ "$STATUS" -eq 0 ]; then
  echo "  Tous les checks passent."
else
  echo "  ⚠ Certains checks ont échoué."
fi

exit $STATUS
