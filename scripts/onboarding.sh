#!/bin/bash
# =============================================================================
# HNTIC Assistant — Script d'onboarding
# =============================================================================
# Usage: ./scripts/onboarding.sh [nom_dirigeant] [nom_entreprise]
#
# Ce script :
# 1. Initialise la business.db
# 2. Prépare le CLAUDE.md du groupe main avec les infos du dirigeant
# 3. Crée les tâches schedulées (flash quotidien, briefing hebdo)
# 4. Affiche les prochaines étapes
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB_PATH="${PROJECT_DIR}/groups/main/business.db"
CLAUDE_MD="${PROJECT_DIR}/groups/main/CLAUDE.md"

DIRIGEANT="${1:-}"
ENTREPRISE="${2:-}"

echo "╔══════════════════════════════════════════╗"
echo "║     HNTIC Assistant — Onboarding         ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# --- Étape 1 : Initialiser la business.db ---
if [ -f "$DB_PATH" ]; then
  echo "✓ business.db existe déjà ($(du -h "$DB_PATH" | cut -f1))"
else
  echo "→ Initialisation de la business.db..."
  bash "$SCRIPT_DIR/init-business-db.sh" "$DB_PATH"
  echo "✓ business.db initialisée"
fi

# --- Étape 2 : Mettre à jour le CLAUDE.md avec les infos du dirigeant ---
if [ -n "$DIRIGEANT" ] && [ -n "$ENTREPRISE" ]; then
  echo "→ Mise à jour du CLAUDE.md avec les infos du dirigeant..."
  sed -i.bak "s/^- Nom :$/- Nom : $DIRIGEANT/" "$CLAUDE_MD"
  sed -i.bak "s/^- Entreprise :$/- Entreprise : $ENTREPRISE/" "$CLAUDE_MD"
  rm -f "${CLAUDE_MD}.bak"
  echo "✓ CLAUDE.md mis à jour (${DIRIGEANT}, ${ENTREPRISE})"
else
  echo "⚠ Pas de nom/entreprise fourni — le CLAUDE.md sera rempli à l'onboarding"
  echo "  Usage: $0 \"Prénom Nom\" \"Nom Entreprise\""
fi

# --- Étape 3 : Créer la structure memory/ ---
MEMORY_DIR="${PROJECT_DIR}/groups/main/memory"
mkdir -p "$MEMORY_DIR/people" "$MEMORY_DIR/projects" "$MEMORY_DIR/context"

if [ ! -f "$MEMORY_DIR/glossary.md" ]; then
  cat > "$MEMORY_DIR/glossary.md" << 'GLOSSARY_EOF'
# Glossaire

Termes, acronymes et raccourcis utilisés par le dirigeant.

| Terme | Signification | Ajouté le |
|-------|--------------|-----------|
GLOSSARY_EOF
  echo "✓ memory/glossary.md créé"
fi

if [ ! -f "$MEMORY_DIR/context/company.md" ]; then
  cat > "$MEMORY_DIR/context/company.md" << 'COMPANY_EOF'
# Contexte entreprise

[À remplir pendant l'onboarding et au fil des conversations]

## Infos générales
- Secteur :
- Taille :
- Date de création :
- Localisation :

## Activité principale


## Clients types


## Concurrents connus

COMPANY_EOF
  echo "✓ memory/context/company.md créé"
fi

if [ ! -f "$MEMORY_DIR/context/preferences.md" ]; then
  cat > "$MEMORY_DIR/context/preferences.md" << 'PREFS_EOF'
# Préférences du dirigeant

[Mis à jour automatiquement par Otto au fil des interactions]

## Communication
- Tutoiement/vouvoiement :
- Horaires préférés :
- Longueur des messages :

## Digests
- Flash quotidien :
- Briefing hebdo :

## Corrections et patterns
<!-- Otto ajoute ici les corrections récurrentes pour ne pas refaire les mêmes erreurs -->

PREFS_EOF
  echo "✓ memory/context/preferences.md créé"
fi

# --- Étape 4 : Créer le fichier schema_log.md ---
SCHEMA_LOG="${PROJECT_DIR}/groups/main/schema_log.md"
if [ ! -f "$SCHEMA_LOG" ]; then
  cat > "$SCHEMA_LOG" << 'SCHEMA_EOF'
# Schema Log

Journal des modifications du schéma business.db.

| Date | Table | Modification | Raison |
|------|-------|-------------|--------|
| (init) | * | Création initiale | Onboarding |
SCHEMA_EOF
  echo "✓ schema_log.md créé"
fi

# --- Étape 4 : Créer le dossier documents ---
DOC_DIR="${PROJECT_DIR}/groups/main/documents"
mkdir -p "$DOC_DIR"
echo "✓ Dossier documents/ prêt"

# --- Résumé ---
echo ""
echo "══════════════════════════════════════════"
echo "Onboarding terminé !"
echo ""
echo "Prochaines étapes :"
echo "  1. Installer WhatsApp :  /add-whatsapp (dans Claude Code)"
echo "  2. Scanner le QR code :  npm run auth"
echo "  3. Builder le container : ./container/build.sh"
echo "  4. Lancer NanoClaw :     npm run dev"
echo ""
echo "  5. Demander à l'assistant (via WhatsApp) :"
echo "     • 'Programme un flash quotidien à 8h'"
echo "     • 'Programme un briefing hebdo le lundi à 7h'"
echo "     • 'Quelles conversations tu écoutes ?'"
echo ""
echo "  6. Pour voir la base de données :"
echo "     pip install datasette"
echo "     datasette $DB_PATH"
echo "══════════════════════════════════════════"
