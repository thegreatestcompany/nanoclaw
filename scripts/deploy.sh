#!/bin/bash
# =============================================================================
# Otto — Déploiement des mises à jour sur le VPS de production
# =============================================================================
# Usage: ./scripts/deploy.sh [--skip-container]
#
# Exécuter depuis le VPS :
#   ssh root@otto.hntic.fr '/opt/otto/app/scripts/deploy.sh'
#
# Options :
#   --skip-container   Ne pas rebuilder l'image Docker agent-runner
#                      (utiliser si seuls les skills/prompts ont changé)
# =============================================================================

set -euo pipefail

SKIP_CONTAINER=false
for arg in "$@"; do
  case $arg in
    --skip-container) SKIP_CONTAINER=true ;;
  esac
done

cd /opt/otto/app

echo "╔══════════════════════════════════════════╗"
echo "║     Otto — Déploiement production        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# 1. Pull latest code
echo "→ Pull du code..."
git pull --ff-only
echo "✓ Code à jour"

# 2. Install dependencies (if package.json changed)
if git diff HEAD~1 --name-only | grep -q "package.json"; then
  echo "→ Installation des dépendances..."
  npm install
  echo "✓ Dépendances installées"
fi

# 3. Build TypeScript
echo "→ Build TypeScript..."
npm run build
echo "✓ Build OK"

# 4. Rebuild container (if container/ changed or not skipped)
if [ "$SKIP_CONTAINER" = false ]; then
  if git diff HEAD~1 --name-only | grep -q "^container/"; then
    echo "→ Rebuild de l'image agent-runner..."
    ./container/build.sh
    echo "✓ Image Docker reconstruite"
  else
    echo "→ Container inchangé, skip rebuild"
  fi
fi

# 5. Build API if it exists
if [ -d "/opt/otto/api" ]; then
  echo "→ Build API d'onboarding..."
  cd /opt/otto/api
  npm install --production
  npm run build
  cd /opt/otto/app
  echo "✓ API OK"
fi

# 6. Rolling restart — one client at a time, 2 sec between each
echo "→ Rolling restart des process PM2..."
if command -v pm2 >/dev/null 2>&1; then
  PROCESS_COUNT=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  if [ "$PROCESS_COUNT" -gt 0 ]; then
    pm2 restart all --parallel 1 --interval 2000
    echo "✓ $PROCESS_COUNT process redémarrés"
  else
    echo "  Aucun process PM2 actif"
  fi
else
  echo "  PM2 non installé (environnement de dev ?)"
fi

# 7. Status
echo ""
echo "══════════════════════════════════════════"
echo "Déploiement terminé !"
if command -v pm2 >/dev/null 2>&1; then
  pm2 list
fi
echo "══════════════════════════════════════════"
