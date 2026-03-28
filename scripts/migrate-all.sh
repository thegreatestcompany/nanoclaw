#!/bin/bash
# =============================================================================
# Otto — Appliquer une migration SQLite à tous les clients
# =============================================================================
# Usage: ./scripts/migrate-all.sh <migration-file>
# Ex:    ./scripts/migrate-all.sh scripts/migrations/002-add-linkedin-url.sql
#
# Les fichiers de migration sont dans scripts/migrations/ et numérotés.
# Les ALTER TABLE ADD COLUMN sont idempotent-safe en SQLite
# (erreur silencieuse si la colonne existe déjà).
# =============================================================================

set -euo pipefail

MIGRATION_FILE="${1:?Usage: $0 <migration-file>}"

if [ ! -f "$MIGRATION_FILE" ]; then
  echo "✗ Fichier introuvable : $MIGRATION_FILE"
  exit 1
fi

echo "Migration : $MIGRATION_FILE"
echo ""

CLIENTS_DIR="${CLIENTS_DIR:-/opt/otto/clients}"
MIGRATED=0
ERRORS=0

# Also migrate the local dev instance if it exists
LOCAL_DB="groups/main/business.db"
if [ -f "$LOCAL_DB" ]; then
  echo "  → local (dev)..."
  sqlite3 "$LOCAL_DB" < "$MIGRATION_FILE" 2>&1 && MIGRATED=$((MIGRATED+1)) || ERRORS=$((ERRORS+1))
fi

# Migrate all client instances
if [ -d "$CLIENTS_DIR" ]; then
  for client_dir in "$CLIENTS_DIR"/*/; do
    client_id=$(basename "$client_dir")
    db_path="$client_dir/groups/main/business.db"

    if [ -f "$db_path" ]; then
      echo "  → $client_id..."
      sqlite3 "$db_path" < "$MIGRATION_FILE" 2>&1 && MIGRATED=$((MIGRATED+1)) || { echo "  ⚠ Erreur sur $client_id"; ERRORS=$((ERRORS+1)); }
    fi
  done
fi

echo ""
echo "Terminé. $MIGRATED migré(s), $ERRORS erreur(s)."
