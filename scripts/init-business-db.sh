#!/bin/bash
# Initialise la base de données business SQLite pour un client HNTIC.
# Usage: ./scripts/init-business-db.sh [chemin_db]
# Par défaut: groups/main/business.db

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="${1:-groups/main/business.db}"

# Créer le répertoire parent si nécessaire
mkdir -p "$(dirname "$DB_PATH")"

echo "Initializing business database at $DB_PATH"
sqlite3 "$DB_PATH" < "$SCRIPT_DIR/init-business-db.sql"

echo "Done. Tables created:"
sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
