#!/bin/bash
# Lance Otto (HNTIC Assistant) en local
# Usage: ./start.sh

set -euo pipefail
cd "$(dirname "$0")"

# Forcer Node 22 (better-sqlite3 ne compile pas sur Node 25)
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH"

# Vérifier Docker
if ! docker info >/dev/null 2>&1; then
  echo "→ Docker n'est pas lancé. Démarrage..."
  open -a Docker
  echo "  Attente de Docker..."
  for i in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker info >/dev/null 2>&1 || { echo "✗ Docker n'a pas démarré. Lance Docker Desktop manuellement."; exit 1; }
fi

echo "✓ Docker OK"
echo "✓ Node $(node -v)"
echo "→ Lancement d'Otto..."
echo ""
exec npx tsx src/index.ts
