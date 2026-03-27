#!/bin/bash
# =============================================================================
# HNTIC Assistant — Déploiement client
# =============================================================================
# Usage: ./scripts/deploy-client.sh <client_name> <anthropic_api_key> [provider]
#
# Provisionne un VPS, installe NanoClaw, configure le service systemd,
# et prépare l'onboarding WhatsApp.
#
# Providers : hetzner (default) | scaleway
# Pré-requis : hcloud CLI ou scw CLI installé et configuré
# =============================================================================

set -euo pipefail

CLIENT_NAME="${1:?Usage: $0 <client_name> <anthropic_api_key> [provider]}"
API_KEY="${2:?Usage: $0 <client_name> <anthropic_api_key> [provider]}"
PROVIDER="${3:-hetzner}"
ASSISTANT_NAME="${4:-Otto}"
REPO_URL="https://github.com/thegreatestcompany/nanoclaw.git"

echo "╔══════════════════════════════════════════╗"
echo "║   HNTIC — Déploiement client             ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Client    : $CLIENT_NAME"
echo "  Provider  : $PROVIDER"
echo "  Assistant : $ASSISTANT_NAME"
echo ""

# --- Étape 1 : Créer le VPS ---
echo "→ Création du VPS..."

if [ "$PROVIDER" = "hetzner" ]; then
  hcloud server create \
    --name "hntic-${CLIENT_NAME}" \
    --type cx22 \
    --image ubuntu-24.04 \
    --location nbg1 \
    --ssh-key hntic-deploy \
    --label env=production \
    --label client="$CLIENT_NAME"

  VPS_IP=$(hcloud server ip "hntic-${CLIENT_NAME}")

elif [ "$PROVIDER" = "scaleway" ]; then
  scw instance server create \
    name="hntic-${CLIENT_NAME}" \
    type=DEV1-M \
    image=ubuntu_noble \
    zone=fr-par-1

  VPS_IP=$(scw instance server get "hntic-${CLIENT_NAME}" -o json | jq -r '.public_ip.address')
else
  echo "✗ Provider inconnu: $PROVIDER (hetzner ou scaleway)"
  exit 1
fi

echo "✓ VPS créé : $VPS_IP"
echo ""

# --- Étape 2 : Attendre que le VPS soit accessible ---
echo "→ Attente de la connexion SSH..."
for i in $(seq 1 30); do
  ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no root@"$VPS_IP" "echo ok" 2>/dev/null && break
  sleep 5
done
echo "✓ SSH accessible"

# --- Étape 3 : Setup sur le VPS ---
echo "→ Installation sur le VPS..."

ssh root@"$VPS_IP" << REMOTE
set -euo pipefail

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs sqlite3

# Clone le repo
git clone ${REPO_URL} /opt/hntic
cd /opt/hntic
npm install

# Build le container agent
./container/build.sh

# Initialiser la business.db
bash scripts/init-business-db.sh groups/main/business.db

# Configurer .env
cat > .env << ENV
ASSISTANT_NAME="${ASSISTANT_NAME}"
ANTHROPIC_API_KEY=${API_KEY}
TZ=Europe/Paris
ENV

# Sync env pour containers
mkdir -p data/env && cp .env data/env/env

# Build TypeScript
npm run build

# Créer les dossiers nécessaires
mkdir -p logs groups/main/documents

# Configurer le service systemd
cat > /etc/systemd/system/hntic-assistant.service << EOF
[Unit]
Description=HNTIC Assistant (${CLIENT_NAME})
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/hntic
EnvironmentFile=/opt/hntic/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=append:/opt/hntic/logs/nanoclaw.log
StandardError=append:/opt/hntic/logs/nanoclaw.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable hntic-assistant

# Configurer le backup quotidien
cat > /etc/cron.d/hntic-backup << CRON
# Backup quotidien à 3h du matin
0 3 * * * root cd /opt/hntic && tar czf /tmp/hntic-backup-\$(date +\%Y\%m\%d).tar.gz groups/ store/messages.db .env && find /tmp -name "hntic-backup-*.tar.gz" -mtime +7 -delete
CRON

# Configurer logrotate
cat > /etc/logrotate.d/hntic << LOGROTATE
/opt/hntic/logs/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
}
LOGROTATE

echo "=== INSTALLATION TERMINÉE ==="
REMOTE

echo ""
echo "══════════════════════════════════════════"
echo "VPS prêt !"
echo ""
echo "Prochaines étapes :"
echo "  1. Connecter WhatsApp :"
echo "     ssh root@$VPS_IP 'cd /opt/hntic && npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser'"
echo ""
echo "  2. Enregistrer le canal principal :"
echo "     ssh root@$VPS_IP 'cd /opt/hntic && npx tsx setup/index.ts --step register --jid \"<JID>\" --name \"$ASSISTANT_NAME\" --trigger \"@${ASSISTANT_NAME,,}\" --folder main --channel whatsapp --assistant-name \"$ASSISTANT_NAME\" --is-main --no-trigger-required'"
echo ""
echo "  3. Démarrer le service :"
echo "     ssh root@$VPS_IP 'systemctl start hntic-assistant'"
echo ""
echo "  4. Vérifier :"
echo "     ssh root@$VPS_IP 'tail -20 /opt/hntic/logs/nanoclaw.log'"
echo ""
echo "  IP du VPS : $VPS_IP"
echo "══════════════════════════════════════════"
