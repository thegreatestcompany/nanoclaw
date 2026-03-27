#!/bin/bash
# =============================================================================
# HNTIC Assistant — Métriques de dogfooding
# =============================================================================
# Usage: ./scripts/metrics.sh [jours] (défaut: 7)
#
# Affiche les métriques clés pour évaluer la qualité de l'assistant :
# - Volume de messages traités
# - Entités business extraites
# - Scan passif : couverture et taux de traitement
# - Activité par table
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MSG_DB="${PROJECT_DIR}/store/messages.db"
BIZ_DB="${PROJECT_DIR}/groups/main/business.db"
DAYS="${1:-7}"
SINCE="datetime('now', '-${DAYS} days')"

echo "╔══════════════════════════════════════════╗"
echo "║     HNTIC — Métriques ($DAYS derniers jours)     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# --- Messages ---
if [ -f "$MSG_DB" ]; then
  echo "═══ MESSAGES ═══"
  echo ""

  TOTAL=$(sqlite3 "$MSG_DB" "SELECT COUNT(*) FROM messages WHERE timestamp > $SINCE")
  HUMAN=$(sqlite3 "$MSG_DB" "SELECT COUNT(*) FROM messages WHERE timestamp > $SINCE AND is_bot_message = 0 AND is_from_me = 0")
  BOT=$(sqlite3 "$MSG_DB" "SELECT COUNT(*) FROM messages WHERE timestamp > $SINCE AND (is_bot_message = 1 OR is_from_me = 1)")
  PROCESSED=$(sqlite3 "$MSG_DB" "SELECT COUNT(*) FROM messages WHERE timestamp > $SINCE AND passive_processed = 1" 2>/dev/null || echo "0")
  UNPROCESSED=$(sqlite3 "$MSG_DB" "SELECT COUNT(*) FROM messages WHERE timestamp > $SINCE AND passive_processed = 0 AND is_bot_message = 0" 2>/dev/null || echo "0")
  CONVERSATIONS=$(sqlite3 "$MSG_DB" "SELECT COUNT(DISTINCT chat_jid) FROM messages WHERE timestamp > $SINCE")

  echo "  Total messages    : $TOTAL"
  echo "  Humains           : $HUMAN"
  echo "  Bot               : $BOT"
  echo "  Conversations     : $CONVERSATIONS"
  echo ""
  echo "  Scan passif :"
  echo "  • Traités         : $PROCESSED"
  echo "  • En attente      : $UNPROCESSED"
  if [ "$HUMAN" -gt 0 ]; then
    PCT=$(echo "scale=0; $PROCESSED * 100 / $HUMAN" | bc 2>/dev/null || echo "?")
    echo "  • Couverture      : ${PCT}%"
  fi
  echo ""
else
  echo "⚠ messages.db introuvable ($MSG_DB)"
  echo ""
fi

# --- Business DB ---
if [ -f "$BIZ_DB" ]; then
  echo "═══ BUSINESS DB ═══"
  echo ""

  for TABLE in contacts companies deals interactions projects invoices expenses obligations meetings documents memories; do
    TOTAL=$(sqlite3 "$BIZ_DB" "SELECT COUNT(*) FROM $TABLE WHERE deleted_at IS NULL OR deleted_at = ''" 2>/dev/null || sqlite3 "$BIZ_DB" "SELECT COUNT(*) FROM $TABLE" 2>/dev/null || echo "0")
    RECENT=$(sqlite3 "$BIZ_DB" "SELECT COUNT(*) FROM $TABLE WHERE created_at > $SINCE" 2>/dev/null || echo "0")
    if [ "$TOTAL" -gt 0 ] || [ "$RECENT" -gt 0 ]; then
      printf "  %-20s : %4s total, %4s nouveaux\n" "$TABLE" "$TOTAL" "$RECENT"
    fi
  done
  echo ""

  # Audit log
  AUDIT_TOTAL=$(sqlite3 "$BIZ_DB" "SELECT COUNT(*) FROM audit_log WHERE created_at > $SINCE" 2>/dev/null || echo "0")
  echo "  Audit log (${DAYS}j)  : $AUDIT_TOTAL entrées"

  # Corrections (updates dans audit_log)
  CORRECTIONS=$(sqlite3 "$BIZ_DB" "SELECT COUNT(*) FROM audit_log WHERE action = 'update' AND created_at > $SINCE" 2>/dev/null || echo "0")
  echo "  Corrections       : $CORRECTIONS"
  echo ""

  # Scan config
  echo "═══ SCAN CONFIG ═══"
  echo ""
  LISTEN=$(sqlite3 "$BIZ_DB" "SELECT COUNT(*) FROM scan_config WHERE mode = 'listen'" 2>/dev/null || echo "0")
  IGNORE=$(sqlite3 "$BIZ_DB" "SELECT COUNT(*) FROM scan_config WHERE mode = 'ignore'" 2>/dev/null || echo "0")
  ACTIVE=$(sqlite3 "$BIZ_DB" "SELECT COUNT(*) FROM scan_config WHERE mode = 'active'" 2>/dev/null || echo "0")
  echo "  Écoute (listen)   : $LISTEN conversations"
  echo "  Ignoré            : $IGNORE conversations"
  echo "  Actif             : $ACTIVE conversations"
  echo ""

  # Pipeline summary
  echo "═══ PIPELINE ═══"
  echo ""
  sqlite3 -header -column "$BIZ_DB" "
    SELECT stage, COUNT(*) as nb, COALESCE(SUM(amount), 0) as montant_total
    FROM deals
    WHERE stage NOT IN ('won','lost') AND (deleted_at IS NULL OR deleted_at = '')
    GROUP BY stage
    ORDER BY
      CASE stage
        WHEN 'lead' THEN 1
        WHEN 'qualified' THEN 2
        WHEN 'proposal' THEN 3
        WHEN 'negotiation' THEN 4
      END
  " 2>/dev/null || echo "  (aucun deal en cours)"
  echo ""
else
  echo "⚠ business.db introuvable ($BIZ_DB)"
  echo "  Exécuter: ./scripts/onboarding.sh"
  echo ""
fi

echo "══════════════════════════════════════════"
