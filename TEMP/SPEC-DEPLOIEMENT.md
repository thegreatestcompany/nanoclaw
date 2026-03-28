# Otto Chief of Staff — Spec de déploiement et infrastructure

## Contexte

Otto est un assistant IA conversationnel pour dirigeants de PME, accessible via WhatsApp. Il fonctionne déjà localement dans un container Docker sur macOS. Cette spec couvre exclusivement le passage en production multi-tenant sur un VPS cloud.

**Ce qui existe déjà :**
- Otto tourne localement dans Docker sur Mac
- Connexion WhatsApp via Baileys fonctionnelle
- Agent SDK Claude fonctionnel
- Business.db SQLite avec le schéma complet

**Ce qu'il faut construire :**
- L'architecture multi-tenant sur VPS
- L'onboarding client self-service (paiement → WhatsApp connecté, zéro intervention)
- La gestion des clés API Anthropic par client
- La mémoire persistante cross-session (Auto Memory n'est PAS dans le SDK)
- Le monitoring et les backups
- Le scaling progressif

---

## 1. Infrastructure VPS

### Hébergeur : Hetzner Cloud

Gamme CCX (vCPU dédiés) pour des performances garanties.

**Progression :**

| Phase | Clients | Instance | RAM | Prix/mois |
|-------|---------|----------|-----|-----------|
| Lancement (0-15) | 1-15 | CCX23 | 16 GB | ~25€ |
| Croissance (15-40) | 15-40 | CCX33 | 32 GB | ~50€ |
| Scale (40-80) | 40-80 | CCX43 | 64 GB | ~100€ |
| Scale+ (80-120) | 80-120 | CCX53 | 128 GB | ~195€ |

Resize = reboot de ~2 minutes, planifiable à 3h du matin. Les messages WhatsApp sont bufferisés par WhatsApp et récupérés au redémarrage.

**Setup initial du VPS :**

```bash
# Créer le VPS via hcloud CLI
hcloud server create \
  --name otto-prod \
  --type ccx23 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key hntic-deploy

# Pointer le DNS
# → Dans Squarespace : ajouter un enregistrement A
#   Host: otto
#   Value: <IP du VPS>
#   → otto.hntic.fr pointe vers le VPS
```

**Provisioning du serveur (à exécuter une seule fois) :**

```bash
#!/bin/bash
# scripts/setup-server.sh

# ─── Système ───
apt update && apt upgrade -y
apt install -y docker.io docker-compose-v2 nodejs npm sqlite3 ufw fail2ban

# ─── Node.js 22 ───
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# ─── PM2 ───
npm install -g pm2
pm2 startup systemd

# ─── Nginx + Let's Encrypt ───
apt install -y nginx certbot python3-certbot-nginx
certbot --nginx -d otto.hntic.fr --non-interactive --agree-tos -m matthieu@hntic.fr

# ─── Firewall ───
ufw allow ssh
ufw allow 'Nginx Full'
ufw enable

# ─── Structure des dossiers ───
mkdir -p /opt/otto/app           # Code Otto (le build Docker exporté en Node.js)
mkdir -p /opt/otto/clients       # Un sous-dossier par client
mkdir -p /opt/otto/api           # L'API d'onboarding
mkdir -p /opt/otto/backups

# ─── Docker : builder l'image agent-runner une seule fois ───
cd /opt/otto/app
./container/build.sh
```

---

## 2. Architecture multi-tenant

### Principe : 1 process PM2 par client, Docker pour les agents éphémères

```
VPS Hetzner Cloud (CCX)
│
├── Nginx (reverse proxy + HTTPS)
│   └── otto.hntic.fr → Otto API (:3000)
│
├── PM2 (process manager)
│   ├── otto-api          → API d'onboarding + webhooks (:3000)
│   ├── otto-dupont       → NanoClaw process (user linux: otto-dupont)
│   ├── otto-martin       → NanoClaw process (user linux: otto-martin)
│   ├── otto-leroy        → NanoClaw process (user linux: otto-leroy)
│   └── ... (40-100 process)
│
├── Docker Engine (sur le host)
│   └── Spawne des containers agent-runner éphémères à la demande
│       Chaque container monte UNIQUEMENT le workspace d'un seul client
│
└── Filesystem
    └── /opt/otto/clients/
        ├── dupont/          (owner: otto-dupont, mode: 700)
        │   ├── groups/main/business.db
        │   ├── groups/main/CLAUDE.md
        │   ├── store/messages.db
        │   └── auth/            (session WhatsApp)
        ├── martin/          (owner: otto-martin, mode: 700)
        └── leroy/           (owner: otto-leroy, mode: 700)
```

### Sécurité inter-clients

- Chaque client a un **utilisateur Linux dédié** (`otto-{clientId}`)
- Les permissions filesystem sont en **700** (seul le propriétaire peut lire/écrire)
- Le process PM2 tourne sous cet utilisateur (`--uid otto-{clientId}`)
- Quand NanoClaw spawne un container agent-runner, il monte **uniquement** le dossier du client concerné
- Le Docker socket reste sur le host — les agents n'y accèdent pas directement (NanoClaw gère le spawn)
- Chaque client a sa propre clé API Anthropic avec un spend limit

### Consommation mémoire par client

| Composant | RAM |
|-----------|-----|
| Process NanoClaw + Baileys (connexion WhatsApp persistante) | ~300-400 MB |
| Container agent éphémère (quand actif) | ~500 MB - 1 GB |
| SQLite | négligeable |
| **Steady state (idle)** | **~350 MB** |
| **Peak (agent actif)** | **~1-1.5 GB** |

Formule : `(RAM totale - 4 GB OS) / 400 MB = nombre max de clients idle`

---

## 3. Nginx — Config HTTPS

```nginx
# /etc/nginx/sites-available/otto.hntic.fr

server {
    listen 443 ssl http2;
    server_name otto.hntic.fr;

    ssl_certificate /etc/letsencrypt/live/otto.hntic.fr/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/otto.hntic.fr/privkey.pem;

    # API d'onboarding + webhooks Stripe
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Page d'onboarding (QR code)
    location /onboard/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }

    # Back-office admin
    location /admin {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }

    # WebSocket pour le QR code live
    location /ws/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;  # 24h pour garder le WS ouvert
    }
}

server {
    listen 80;
    server_name otto.hntic.fr;
    return 301 https://$host$request_uri;
}
```

Nginx c'est juste le portier du VPS. Il reçoit les requêtes HTTPS sur `otto.hntic.fr` et les transmet à ton API d'onboarding qui tourne sur le port 3000. C'est l'équivalent de ce que Vercel fait automatiquement — mais sur ton serveur.

---

## 4. API d'onboarding self-service

### Stack

- **Express.js** ou **Fastify** (même langage que Otto, pas de stack en plus)
- ~300-400 lignes de code
- Tourne comme un process PM2 (`otto-api`)

### Fichier principal : `/opt/otto/api/index.ts`

```typescript
import express from 'express';
import Stripe from 'stripe';
import { execSync } from 'child_process';
import crypto from 'crypto';
import pm2 from 'pm2';
import Database from 'better-sqlite3';
import { WebSocketServer } from 'ws';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const db = new Database('/opt/otto/api/onboarding.db');

// ─── Init DB ───
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    stripe_customer_id TEXT,
    anthropic_workspace_id TEXT,
    anthropic_api_key_id TEXT,
    status TEXT DEFAULT 'provisioning',
    onboard_token TEXT,
    onboard_token_expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ─── Webhook Stripe ───
app.post('/api/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature']!;
    const event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email!;
      const clientId = slugify(email);

      await provisionClient(clientId, email, session.customer!);
      res.json({ ok: true });
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const client = db.prepare(
        'SELECT * FROM clients WHERE stripe_customer_id = ?'
      ).get(sub.customer);
      if (client) await deprovisionClient(client.id);
      res.json({ ok: true });
    }
  }
);

// ─── Page d'onboarding ───
app.get('/onboard/:token', (req, res) => {
  const client = db.prepare(
    'SELECT * FROM clients WHERE onboard_token = ? AND onboard_token_expires_at > datetime("now")'
  ).get(req.params.token);

  if (!client) return res.status(404).send('Lien expiré ou invalide.');

  // Servir la page HTML avec le QR code live
  res.sendFile('/opt/otto/api/public/onboard.html');
});

// ─── Provisioning ───
async function provisionClient(clientId: string, email: string, stripeCustomerId: string) {

  // 1. Créer le workspace Anthropic + clé API
  //    Via l'Admin API Anthropic (nécessite une clé admin sk-ant-admin-...)
  const workspace = await createAnthropicWorkspace(clientId);
  const apiKey = await createAnthropicApiKey(workspace.id, clientId);

  // 2. Créer l'utilisateur Linux + dossiers
  execSync(`
    sudo useradd -r -s /bin/false otto-${clientId} 2>/dev/null || true
    mkdir -p /opt/otto/clients/${clientId}/{groups/main,store,auth}
    sqlite3 /opt/otto/clients/${clientId}/groups/main/business.db < /opt/otto/app/scripts/init-business-db.sql
    chown -R otto-${clientId}: /opt/otto/clients/${clientId}/
    chmod 700 /opt/otto/clients/${clientId}/
  `);

  // 3. Écrire le .env du client
  const envContent = [
    `ANTHROPIC_API_KEY=${apiKey.key}`,
    `ASSISTANT_NAME=Otto`,
    `TZ=Europe/Paris`,
    `CLIENT_ID=${clientId}`,
  ].join('\n');
  fs.writeFileSync(`/opt/otto/clients/${clientId}/.env`, envContent);
  execSync(`chown otto-${clientId}: /opt/otto/clients/${clientId}/.env`);
  execSync(`chmod 600 /opt/otto/clients/${clientId}/.env`);

  // 4. Lancer le process NanoClaw via PM2
  execSync(`
    pm2 start /opt/otto/app/dist/index.js \
      --name otto-${clientId} \
      --uid otto-${clientId} \
      --env-file /opt/otto/clients/${clientId}/.env \
      -- --data-dir /opt/otto/clients/${clientId}
  `);
  execSync('pm2 save');

  // 5. Générer le token d'onboarding
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO clients (id, email, stripe_customer_id, anthropic_workspace_id, anthropic_api_key_id, onboard_token, onboard_token_expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_whatsapp')
  `).run(clientId, email, stripeCustomerId, workspace.id, apiKey.id, token, expiresAt);

  // 6. Envoyer l'email
  await sendOnboardingEmail(email, token);
}

// ─── Dé-provisioning (résiliation) ───
async function deprovisionClient(clientId: string) {
  // Stopper le process
  execSync(`pm2 stop otto-${clientId} && pm2 delete otto-${clientId}`);
  execSync('pm2 save');

  // Révoquer la clé API Anthropic
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (client?.anthropic_api_key_id) {
    await revokeAnthropicApiKey(client.anthropic_api_key_id);
  }

  // Archiver les données (pas supprimer — RGPD, le client peut demander un export)
  execSync(`
    tar czf /opt/otto/backups/${clientId}-$(date +%Y%m%d).tar.gz /opt/otto/clients/${clientId}/
    rm -rf /opt/otto/clients/${clientId}/
    sudo userdel otto-${clientId} 2>/dev/null || true
  `);

  db.prepare('UPDATE clients SET status = ? WHERE id = ?').run('cancelled', clientId);
}

// ─── Helpers Anthropic Admin API ───
async function createAnthropicWorkspace(clientId: string) {
  const res = await fetch('https://api.anthropic.com/v1/organizations/workspaces', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_ADMIN_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: `otto-${clientId}`,
    })
  });
  return res.json();
}

async function createAnthropicApiKey(workspaceId: string, clientId: string) {
  const res = await fetch('https://api.anthropic.com/v1/organizations/api_keys', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_ADMIN_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: `otto-${clientId}`,
      workspace_id: workspaceId,
    })
  });
  return res.json();
}

// ─── WebSocket pour QR code live ───
const wss = new WebSocketServer({ noServer: true });

app.server = app.listen(3000);
app.server.on('upgrade', (req, socket, head) => {
  const token = req.url?.replace('/ws/', '');
  const client = db.prepare(
    'SELECT * FROM clients WHERE onboard_token = ?'
  ).get(token);
  if (!client) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Écouter les messages IPC de PM2 pour ce client
    pm2.connect(() => {
      pm2.launchBus((err, bus) => {
        bus.on('process:msg', (packet: any) => {
          if (packet.process.name !== `otto-${client.id}`) return;
          if (packet.data?.type === 'qr') {
            ws.send(JSON.stringify({ type: 'qr', data: packet.data.qr }));
          }
          if (packet.data?.type === 'connected') {
            ws.send(JSON.stringify({ type: 'connected' }));
            // Mettre à jour le statut
            db.prepare('UPDATE clients SET status = ? WHERE id = ?')
              .run('active', client.id);
          }
        });
      });
    });
  });
});

function slugify(email: string): string {
  return email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
}
```

### Page d'onboarding : `/opt/otto/api/public/onboard.html`

```html
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Otto — Connecte ton WhatsApp</title>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
  <style>
    body { font-family: system-ui; max-width: 480px; margin: 40px auto; padding: 20px; text-align: center; background: #0a0a0a; color: #fff; }
    canvas { margin: 24px auto; display: block; border-radius: 12px; }
    .status { font-size: 18px; margin: 24px 0; }
    .success { color: #22c55e; }
    .waiting { color: #f59e0b; }
    .steps { text-align: left; background: #1a1a1a; padding: 20px; border-radius: 12px; margin: 24px 0; }
    .steps li { margin: 8px 0; color: #ccc; }
  </style>
</head>
<body>
  <h1>🤵 Otto</h1>
  <p>Ton assistant Chief of Staff est prêt.</p>

  <div id="qr-section">
    <div class="status waiting" id="status">Connexion en cours...</div>
    <canvas id="qrcode"></canvas>
    <ol class="steps">
      <li>Ouvre WhatsApp sur ton téléphone</li>
      <li>Va dans Paramètres → Appareils liés</li>
      <li>Appuie sur "Lier un appareil"</li>
      <li>Scanne le QR code ci-dessus</li>
    </ol>
  </div>

  <div id="success-section" style="display:none">
    <div class="status success">✅ WhatsApp connecté !</div>
    <p>Otto va t'envoyer un message dans WhatsApp dans quelques secondes.</p>
    <p>Tu peux fermer cette page.</p>
  </div>

  <script>
    const token = window.location.pathname.split('/onboard/')[1];
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/${token}`);

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'qr') {
        QRCode.toCanvas(document.getElementById('qrcode'), msg.data, {
          width: 280, margin: 2, color: { dark: '#000', light: '#fff' }
        });
        document.getElementById('status').textContent = 'Scanne ce QR code avec WhatsApp';
      }
      if (msg.type === 'connected') {
        document.getElementById('qr-section').style.display = 'none';
        document.getElementById('success-section').style.display = 'block';
      }
    };

    ws.onerror = () => {
      document.getElementById('status').textContent = 'Erreur de connexion. Recharge la page.';
    };
  </script>
</body>
</html>
```

---

## 5. Modification dans Otto (NanoClaw) — Exposer le QR code via IPC

Dans le channel WhatsApp (`src/channels/whatsapp.ts`), ajouter l'envoi du QR code au process parent via IPC PM2 :

```typescript
// Dans le handler connection.update de Baileys
sock.ev.on('connection.update', async (update) => {
  const { connection, qr } = update;

  if (qr) {
    // Envoyer le QR au process parent (PM2 bus)
    // pm2 capte les messages envoyés via process.send()
    if (process.send) {
      process.send({ type: 'qr', qr });
    }
  }

  if (connection === 'open') {
    if (process.send) {
      process.send({ type: 'connected' });
    }
  }
});
```

C'est la modification minimale pour l'onboarding. L'autre modification significative dans Otto est le système de mémoire persistante (voir section 13).

---

## 6. Gestion des clés API Anthropic

### Architecture : 1 Workspace Anthropic par client

```
Organisation HNTIC (Anthropic Console)
│
├── Workspace "otto-dupont"
│   ├── API Key: sk-ant-api03-xxx (générée automatiquement)
│   ├── Spend limit: 200$/mois (sécurité)
│   └── Usage tracking isolé
│
├── Workspace "otto-martin"
│   ├── API Key: sk-ant-api03-yyy
│   ├── Spend limit: 200$/mois
│   └── Usage tracking isolé
│
└── ...
```

### Pourquoi 1 workspace par client

- **Isolation des coûts** : tu vois exactement combien chaque client te coûte via l'API Usage d'Anthropic
- **Spend limits** : si un client dérape (boucle infinie, abus), le plafond bloque — les autres clients ne sont pas affectés
- **Résiliation propre** : tu révoques la clé, le client est coupé instantanément, aucun impact sur les autres
- **Audit** : traçabilité complète par workspace pour la facturation et le RGPD

### Ce qu'il te faut

- Une **clé Admin** Anthropic (`sk-ant-admin-...`) — se génère dans la Console, section Admin API keys. Seul toi (admin de l'organisation) peux en créer.
- Cette clé Admin est stockée **uniquement** dans le `.env` de l'API d'onboarding, pas dans les clients.
- Les clés API par client sont générées automatiquement par l'Admin API et injectées dans le `.env` de chaque client.

### Monitoring des coûts

Tâche cron quotidienne qui query l'API Usage Anthropic et logge les coûts par client :

```bash
# /opt/otto/scripts/daily-cost-check.sh
# Appelé par cron à 7h tous les jours

curl -s "https://api.anthropic.com/v1/organizations/usage_report/messages?\
starting_at=$(date -d 'yesterday' +%Y-%m-%dT00:00:00Z)&\
ending_at=$(date +%Y-%m-%dT00:00:00Z)&\
group_by[]=workspace_id&\
bucket_width=1d" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY" \
  > /opt/otto/logs/costs/$(date +%Y-%m-%d).json
```

---

## 7. Stripe — Configuration

### Produit Stripe

Créer dans le dashboard Stripe :
- **Produit** : "Otto Chief of Staff"
- **Prix** : 500€ HT/mois (récurrent)
- **Mode checkout** : `subscription`

### Webhook Stripe

Dans Stripe Dashboard → Developers → Webhooks :
- **URL** : `https://otto.hntic.fr/api/stripe-webhook`
- **Events** : `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`

### Lien de souscription

Sur hntic.fr, le bouton "Souscrire" pointe vers une Stripe Checkout Session. Tu peux soit :
- Créer un **Payment Link** dans Stripe (le plus simple, zéro code)
- Ou créer une Checkout Session via l'API Stripe (si tu veux du custom)

Le Payment Link est suffisant pour démarrer. Tu le crées en 2 minutes dans le dashboard Stripe.

---

## 8. Backups

```bash
# /etc/cron.d/otto-backup
# Backup quotidien à 3h du matin

0 3 * * * root /opt/otto/scripts/backup.sh
```

```bash
#!/bin/bash
# /opt/otto/scripts/backup.sh

BACKUP_DIR="/opt/otto/backups"
DATE=$(date +%Y%m%d)

# Backup de tous les clients
for client_dir in /opt/otto/clients/*/; do
  client_id=$(basename "$client_dir")
  tar czf "$BACKUP_DIR/${client_id}-${DATE}.tar.gz" "$client_dir"
done

# Backup de la DB d'onboarding
cp /opt/otto/api/onboarding.db "$BACKUP_DIR/onboarding-${DATE}.db"

# Nettoyage : garder 30 jours
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +30 -delete
find "$BACKUP_DIR" -name "*.db" -mtime +30 -delete

# Upload vers Hetzner Storage Box (optionnel, ~3€/mois pour 1 TB)
# rsync -az "$BACKUP_DIR/" u123456@u123456.your-storagebox.de:otto-backups/
```

---

## 9. Monitoring

### PM2 monitoring

```bash
# Voir tous les process
pm2 list

# Dashboard temps réel
pm2 monit

# Logs d'un client
pm2 logs otto-dupont

# Redémarrer un client
pm2 restart otto-dupont
```

### Healthcheck

Tâche cron toutes les 5 minutes qui vérifie que tous les process tournent :

```bash
#!/bin/bash
# /opt/otto/scripts/healthcheck.sh

EXPECTED=$(pm2 jlist | jq '[.[] | select(.name | startswith("otto-"))] | length')
RUNNING=$(pm2 jlist | jq '[.[] | select(.name | startswith("otto-")) | select(.pm2_env.status == "online")] | length')

if [ "$RUNNING" -lt "$EXPECTED" ]; then
  # Alerter via Telegram/email
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=⚠️ Otto: ${RUNNING}/${EXPECTED} process actifs. Vérifier pm2 list."
fi
```

### Monitoring des coûts (alerte si dépassement)

Intégré dans le script `daily-cost-check.sh` — si un client dépasse 150$/mois, envoyer une alerte.

---

## 10. Commandes opérationnelles

### Ajouter un client manuellement (hors Stripe)

```bash
/opt/otto/scripts/provision-client.sh <client-id> <email>
```

### Stopper un client temporairement

```bash
pm2 stop otto-{clientId}
```

### Relancer un client

```bash
pm2 restart otto-{clientId}
```

### Voir les coûts d'un client

```bash
# Via l'API Anthropic
curl "https://api.anthropic.com/v1/organizations/cost_report?\
starting_at=$(date -d '-30 days' +%Y-%m-%dT00:00:00Z)&\
ending_at=$(date +%Y-%m-%dT00:00:00Z)&\
group_by[]=workspace_id" \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $ANTHROPIC_ADMIN_KEY"
```

### Mettre à jour le code Otto pour tous les clients

```bash
cd /opt/otto/app
git pull
npm run build
./container/build.sh        # rebuild l'image agent-runner
pm2 restart all              # relance tous les process
```

### Resize le VPS

```bash
# 1. À 3h du matin, stopper le scheduler
pm2 stop all

# 2. Resize via hcloud (ou dans la console web Hetzner)
hcloud server change-type otto-prod ccx33

# 3. Le serveur reboot automatiquement (~2 min)
# 4. PM2 relance tout automatiquement (pm2 startup)
```

---

## 11. RGPD Checklist

| Obligation | Action |
|------------|--------|
| DPA Hetzner | Activer dans la console Hetzner (gratuit) |
| DPA Anthropic | Signer via la console Anthropic |
| DPA Stripe | Inclus dans les Stripe Terms of Service |
| Registre des traitements (art. 30) | Documenter : quelles données, pourquoi, combien de temps, qui y accède |
| Information des clients | CGV/mentions légales expliquant le traitement IA via Anthropic (US) avec SCC |
| Droit d'export | `tar czf` du dossier client → envoi par email ou lien de téléchargement |
| Droit de suppression | `deprovisionClient()` + suppression des backups après 30 jours |
| Sécurité des données | Users Linux isolés, permissions 700, clés API séparées, HTTPS, chiffrement WhatsApp E2E |

---

## 12. Flow complet résumé

```
1. Dirigeant découvre Otto sur hntic.fr
2. Clique "Souscrire" → Stripe Checkout (500€/mois)
3. Paiement OK → Webhook Stripe → otto.hntic.fr/api/stripe-webhook
4. Auto-provisioning (~30 sec) :
   a. Workspace Anthropic créé + clé API générée
   b. User Linux créé + dossiers + business.db initialisée
   c. Process NanoClaw lancé via PM2
   d. Token d'onboarding généré
5. Email envoyé au client : "Connecte ton WhatsApp → otto.hntic.fr/onboard/xxx"
6. Client ouvre le lien → QR code affiché en temps réel
7. Client scanne avec WhatsApp → connexion établie
8. Otto envoie son premier message dans WhatsApp
9. Onboarding conversationnel : Otto pose les questions, stocke dans business.db, construit le CLAUDE.md et memory/
10. Lundi matin → premier digest automatique
11. Dimanche soir → AutoDream consolide la mémoire de la semaine

Zéro intervention humaine du step 1 au step 10.
```

---

## 13. Mémoire persistante cross-session

### Le problème

Le Claude Agent SDK **n'inclut pas** la feature Auto Memory de Claude Code. Chaque session démarre avec le CLAUDE.md + le session resume, mais l'agent ne mémorise pas automatiquement ce qu'il apprend sur le dirigeant entre les sessions. Si le dirigeant dit "je préfère qu'on me tutoie" ou "quand je dis Dupont c'est Jean-Pierre Dupont chez Acme", cette info doit persister pour toujours — pas seulement pendant la session en cours.

### Architecture mémoire à implémenter

Basée sur le skill `memory-management` des knowledge-work-plugins Anthropic (Apache-2.0) :

```
/opt/otto/clients/{clientId}/
├── groups/main/
│   ├── CLAUDE.md                  ← Hot cache (~50-80 lignes)
│   ├── business.db                ← Mémoire structurée (CRM, finance, RH)
│   └── memory/                    ← Mémoire profonde
│       ├── glossary.md            ← Glossaire complet (noms, acronymes, termes internes)
│       ├── people/                ← Profils détaillés par contact
│       │   ├── dupont-jean-pierre.md
│       │   └── martin-sophie.md
│       ├── projects/              ← Contexte par projet
│       │   └── refonte-si.md
│       └── context/               ← Infos entreprise
│           ├── company.md         ← Secteur, taille, historique
│           ├── team.md            ← Organigramme, rôles
│           └── preferences.md     ← Préférences de communication du dirigeant
```

### Hot cache : CLAUDE.md

Le CLAUDE.md est lu à chaque session. Il doit rester compact (~50-80 lignes) pour ne pas consommer trop de tokens. Contenu :

```markdown
## Dirigeant
| Champ | Valeur |
|-------|--------|
| Nom | Jean Dupont |
| Entreprise | Acme SAS |
| Tutoiement | oui |
| Horaires digest | flash 8h, hebdo lundi 7h |

## Contacts fréquents (top 30)
| Nom | Entreprise | Rôle | Contexte rapide |
|-----|-----------|------|-----------------|
| Sophie Martin | BankCo | Directrice achats | Deal 120K en négo |
| Pierre Leroy | Acme | DRH | Fin PE dans 2 mois |
| ... | | | |

## Acronymes courants
| Terme | Signification |
|-------|--------------|
| PSR | Pipeline Status Report (hebdo) |
| TJM | Taux Journalier Moyen |
| PE | Période d'essai |
| ... | |

## Projets actifs
| Projet | Statut | Prochaine étape |
|--------|--------|-----------------|
| Refonte SI | En cours | Livraison phase 2 le 15/04 |
| Recrutement dev | Offre envoyée | Réponse attendue 01/04 |
```

### Flow de lookup (à chaque message reçu)

```
Message du dirigeant : "Demande à Sophie le PSR pour Phoenix"
                              ↓
1. Chercher dans CLAUDE.md (hot cache)
   → Sophie ? ✓ Sophie Martin, BankCo, deal 120K
   → PSR ? ✓ Pipeline Status Report
   → Phoenix ? ✗ pas trouvé
                              ↓
2. Chercher dans memory/glossary.md
   → Phoenix ? ✓ Nom de code du projet de migration cloud
                              ↓
3. Si toujours pas trouvé → demander au dirigeant
   → "C'est quoi Phoenix ? Je le note pour ne plus te demander."
```

### Écriture en mémoire (pendant chaque session)

Après chaque interaction significative, l'agent doit se demander : "Est-ce que j'ai appris quelque chose de nouveau qui serait utile dans les prochaines sessions ?"

**Types d'infos à mémoriser automatiquement :**
- Corrections du dirigeant ("Non, Dupont c'est 55K pas 45K")
- Préférences ("Envoie-moi les digests plus tôt, à 6h30")
- Nouveaux acronymes ou raccourcis
- Nouveaux contacts mentionnés pour la première fois
- Décisions stratégiques
- Patterns de correction récurrents

**Implémentation :** Ajouter un hook PostToolUse ou en fin de session qui :

```typescript
// Pseudo-code — à la fin de chaque session
const sessionLearnings = await query({
  prompt: `Analyse cette conversation et identifie les nouvelles informations 
           qui devraient être mémorisées pour les futures sessions.
           
           Catégories : correction, préférence, nouveau contact, acronyme, 
           décision, pattern.
           
           Retourne un JSON avec les infos à stocker.
           Si rien de nouveau, retourne un tableau vide.`,
  options: {
    model: 'haiku',  // pas cher, c'est de la classification
    maxTurns: 1,
  }
});

// Stocker dans memory/ et/ou mettre à jour le CLAUDE.md
```

### AutoDream : consolidation hebdomadaire

Tâche cron dimanche soir (en Haiku pour le coût) qui consolide la mémoire de chaque client :

```bash
# Cron : 0 22 * * 0 (dimanche 22h)
# Pour chaque client actif, lancer un agent de consolidation
```

L'agent de consolidation fait :

1. **Relire** toutes les nouvelles entrées dans `memory/` depuis la dernière consolidation
2. **Dédupliquer** — fusionner les entrées qui disent la même chose
3. **Corriger les contradictions** — si une mémoire ancienne dit "deal à 45K" et une récente dit "deal à 55K", garder la récente et supprimer l'ancienne
4. **Convertir les dates relatives** — "hier on a décidé de..." → "le 15/03/2026 on a décidé de..."
5. **Supprimer les mémoires obsolètes** — un deal marqué `won` ou `lost` n'a plus besoin d'être dans le hot cache
6. **Mettre à jour le CLAUDE.md** :
   - Ajouter les nouveaux contacts fréquents (apparus 3+ fois cette semaine)
   - Retirer les contacts qui n'apparaissent plus depuis 30 jours
   - Mettre à jour les projets actifs
   - Garder le fichier sous 80 lignes
7. **Mettre à jour les relationship_summaries** dans la business.db pour chaque contact avec des interactions récentes

### Budget mémoire

| Opération | Fréquence | Modèle | Coût estimé/client |
|-----------|-----------|--------|-------------------|
| Extraction des learnings en fin de session | Chaque session | Haiku | ~0.01$/session |
| Lookup dans memory/glossary.md | Chaque message si besoin | Haiku | ~0.005$/lookup |
| AutoDream (consolidation hebdo) | 1x/semaine | Haiku | ~0.10$/semaine |
| **Total mensuel** | | | **~2-5$/mois** |

Négligeable par rapport au coût des réponses Sonnet (~50-120$/mois).

### Source d'inspiration

Le skill `memory-management` du repo `anthropics/knowledge-work-plugins` (Apache-2.0) contient l'architecture complète à adapter. Le flow de lookup en 3 tiers, le format du CLAUDE.md en tables compactes, et la logique de consolidation sont déjà documentés.

Fichier source : `knowledge-work-plugins/productivity/skills/memory-management/SKILL.md`

Il faut adapter :
- Le stockage des profils people/ → utiliser aussi la table `contacts` de business.db
- Le glossaire → enrichir avec les termes métier du client (détectés automatiquement)
- Le cycle de consolidation → brancher sur le scheduler NanoClaw existant au lieu d'un cron externe

---

## 14. Mises à jour et déploiement de nouvelles features

### Principe

Le code Otto vit dans un repo Git. Le VPS fait un `git pull` pour récupérer les changements. Selon ce qui a changé, il faut rebuild et/ou redémarrer.

### Types de changements et procédures

#### Skills / prompts (SKILL.md, CLAUDE.md templates)

Les skills sont lus dynamiquement par le SDK à chaque nouvelle session. Aucun restart nécessaire.

```bash
cd /opt/otto/app
git pull
# C'est tout. Le prochain message d'un client utilisera le nouveau skill.
```

#### Code Otto (Node.js — src/, package.json)

```bash
cd /opt/otto/app
git pull
npm install          # si les dépendances ont changé
npm run build

# Rolling restart — un client à la fois, 2 sec entre chaque
pm2 restart all --parallel 1 --interval 2000
```

Chaque client met ~5 secondes à redémarrer. Baileys se reconnecte automatiquement. Les messages en attente sont récupérés par WhatsApp. Les clients ne voient rien sauf un délai de quelques secondes.

#### Agent-runner (le container Docker — container/)

```bash
cd /opt/otto/app
git pull
./container/build.sh   # rebuild l'image Docker

# Rolling restart
pm2 restart all --parallel 1 --interval 2000
```

Les containers éphémères utiliseront la nouvelle image dès le prochain message.

#### API d'onboarding (otto-api)

```bash
cd /opt/otto/api
git pull
npm install
npm run build
pm2 restart otto-api   # ~2 sec de downtime, n'affecte pas les clients Otto
```

#### Schéma SQLite (ajout de colonnes / tables)

Les migrations doivent être appliquées sur chaque client. Convention : un fichier SQL numéroté par migration dans `scripts/migrations/`.

```
scripts/migrations/
├── 001-initial-schema.sql
├── 002-add-scan-config-priority.sql
├── 003-add-contacts-linkedin-url.sql
└── ...
```

Script de migration :

```bash
#!/bin/bash
# scripts/migrate-all.sh <migration-file>
# Usage: ./scripts/migrate-all.sh scripts/migrations/003-add-contacts-linkedin-url.sql

MIGRATION_FILE=$1

if [ -z "$MIGRATION_FILE" ]; then
  echo "Usage: $0 <migration-file>"
  exit 1
fi

echo "Applying migration: $MIGRATION_FILE"

for client_dir in /opt/otto/clients/*/; do
  client_id=$(basename "$client_dir")
  db_path="$client_dir/groups/main/business.db"

  if [ -f "$db_path" ]; then
    echo "  Migrating $client_id..."
    sqlite3 "$db_path" < "$MIGRATION_FILE" 2>&1 || echo "  ⚠️ Error on $client_id"
  fi
done

echo "Done. Migrated $(ls -d /opt/otto/clients/*/ | wc -l) clients."
```

Exemple de fichier de migration :

```sql
-- scripts/migrations/003-add-contacts-linkedin-url.sql
-- Ajouter une colonne LinkedIn aux contacts

ALTER TABLE contacts ADD COLUMN linkedin_url TEXT;

-- Les ALTER TABLE ADD COLUMN sont idempotent-safe en SQLite
-- (erreur silencieuse si la colonne existe déjà quand on utilise 2>&1)
```

Aucun restart nécessaire. Les process Otto utilisent les nouvelles colonnes immédiatement.

### Résumé des procédures

| Changement | Commandes VPS | Restart ? | Downtime client |
|---|---|---|---|
| Skill / prompt | `git pull` | Non | Zéro |
| CLAUDE.md template | `git pull` | Non (nouveaux clients uniquement) | Zéro |
| Code Otto (Node.js) | `git pull && npm run build && pm2 restart all` | Oui (rolling) | ~5 sec/client |
| Agent-runner (Docker) | `git pull && ./container/build.sh && pm2 restart all` | Oui (rolling) | ~5 sec/client |
| API d'onboarding | `git pull && npm run build && pm2 restart otto-api` | Oui (api seule) | ~2 sec (pas d'impact clients) |
| Schéma SQLite | `git pull && ./scripts/migrate-all.sh <file>` | Non | Zéro |
| Dépendances npm | `git pull && npm install && npm run build && pm2 restart all` | Oui (rolling) | ~5 sec/client |

### Script de déploiement complet (one-liner)

Pour les mises à jour qui touchent à tout :

```bash
#!/bin/bash
# scripts/deploy.sh — Déploiement complet

set -e

cd /opt/otto/app
echo "📥 Pulling latest code..."
git pull

echo "📦 Installing dependencies..."
npm install

echo "🔨 Building..."
npm run build

echo "🐳 Rebuilding agent-runner..."
./container/build.sh

echo "🔄 Rolling restart..."
pm2 restart all --parallel 1 --interval 2000

echo "✅ Deploy complete. Status:"
pm2 list
```

Usage : `ssh root@otto.hntic.fr '/opt/otto/app/scripts/deploy.sh'` — exécutable depuis ton Mac en une commande.

---

## 15. Stockage des pièces jointes

### Structure par client

Les documents reçus via WhatsApp (PDF, images, vocaux) sont stockés dans le dossier du client :

```
/opt/otto/clients/dupont/
├── groups/main/
│   ├── business.db
│   ├── CLAUDE.md
│   ├── memory/
│   └── documents/                    ← pièces jointes
│       ├── 1711612800_facture-acme.pdf
│       ├── 1711613400_carte-visite.jpg
│       └── 1711614000_vocal-dupont.ogg
```

Chaque fichier est indexé dans la table `documents` de la business.db :

```sql
-- Exemple d'entrée
INSERT INTO documents (id, title, category, file_path, file_type, extracted_text,
  source_chat_jid, related_contact_id)
VALUES ('a1b2c3', 'Facture Acme mars 2026', 'invoice',
  'documents/1711612800_facture-acme.pdf', 'pdf',
  'Facture N°2026-042 — Acme SAS — Montant: 12 450€ HT...',
  '33612345678@s.whatsapp.net', 'contact-id-dupont');
```

### Estimation de consommation disk

| Type | Taille moyenne | 50 clients × 20 docs/mois | En 1 an |
|---|---|---|---|
| PDF | ~500 KB | 500 MB/mois | 6 GB |
| Image | ~1 MB | 1 GB/mois | 12 GB |
| Vocal | ~2 MB/min | 2 GB/mois | 24 GB |
| **Total** | | **~3.5 GB/mois** | **~42 GB** |

Les VPS CCX ont ~80 GB de disk. À 50 clients actifs, le disk se remplit en ~18 mois.

### Phase 1 (lancement) : Volume Hetzner Cloud attaché

Ajouter un volume block storage au VPS. Extensible à chaud, sans downtime.

```bash
# Créer le volume
hcloud volume create --name otto-documents --size 100 --server otto-prod

# Il se monte automatiquement sur /mnt/HC_Volume_xxxxx
# Créer un lien symbolique propre
ln -s /mnt/HC_Volume_xxxxx /opt/otto/storage

# Coût : ~4€/mois pour 100 GB, extensible à tout moment
```

Modifier le chemin de stockage des documents dans Otto pour utiliser `/opt/otto/storage/{clientId}/documents/` au lieu de `/opt/otto/clients/{clientId}/groups/main/documents/`.

Les permissions restent identiques — chaque dossier client est owned par son user Linux dédié.

```bash
# Setup pour un nouveau client (ajouter dans le provisioning)
mkdir -p /opt/otto/storage/${clientId}/documents
chown otto-${clientId}: /opt/otto/storage/${clientId}/documents
chmod 700 /opt/otto/storage/${clientId}/documents

# Symlink dans le workspace du client pour que NanoClaw le voie
ln -s /opt/otto/storage/${clientId}/documents \
  /opt/otto/clients/${clientId}/groups/main/documents
```

### Phase 2 (scaling) : Hetzner Object Storage (S3-compatible)

Quand le volume approche des 80%, migrer vers du stockage objet :

```bash
# Coût : ~3€/mois pour 1 TB — quasi illimité
# Compatible S3 (aws-cli, s3cmd, SDK)
```

Le flow devient :

```
1. WhatsApp reçoit un document
2. Otto le stocke temporairement dans /tmp/
3. Otto extrait le texte (pdftotext, Vision, Whisper)
4. Le texte extrait est stocké dans business.db (table documents)
5. Le fichier original est uploadé vers Object Storage
6. Le file_path dans business.db est mis à jour avec l'URL S3
7. Le fichier local est supprimé

→ Seul le texte extrait reste sur le VPS, pas les fichiers lourds
```

Script de nettoyage pour les fichiers locaux > 30 jours (phase transitoire) :

```bash
#!/bin/bash
# scripts/cleanup-old-documents.sh
# Cron : 0 4 * * 0 (dimanche 4h)

find /opt/otto/storage/*/documents/ -type f -mtime +30 -delete
echo "Cleaned documents older than 30 days"
```

### Backups des documents

Les documents sur le volume Hetzner sont inclus dans le backup quotidien (section 8). Ajouter le volume au script :

```bash
# Dans scripts/backup.sh, ajouter :
for client_dir in /opt/otto/storage/*/; do
  client_id=$(basename "$client_dir")
  tar czf "$BACKUP_DIR/${client_id}-docs-${DATE}.tar.gz" "$client_dir"
done
```

Si Object Storage est activé, les fichiers y sont déjà redondants — pas besoin de backup supplémentaire.

---

## 16. Back-office admin — `otto.hntic.fr/admin`

### Principe

Pas d'outil externe (Portainer, etc.). Le back-office est intégré dans l'API d'onboarding (`otto-api`). C'est un ensemble de routes API en lecture seule + une page frontend simple. Protégé par un token admin.

### Routes API

Ajouter dans `/opt/otto/api/index.ts` :

```typescript
// ─── Auth admin ───
const requireAdmin = (req, res, next) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ─── Liste des clients + statuts PM2 + stats ───
app.get('/api/admin/clients', requireAdmin, async (req, res) => {
  const pm2List = JSON.parse(execSync('pm2 jlist').toString());
  const ottoProcesses = pm2List.filter(
    p => p.name.startsWith('otto-') && p.name !== 'otto-api'
  );

  const clients = ottoProcesses.map((proc) => {
    const clientId = proc.name.replace('otto-', '');
    const dbPath = `/opt/otto/clients/${clientId}/groups/main/business.db`;
    let stats = {};

    try {
      const db = new Database(dbPath, { readonly: true });
      stats = {
        contacts: db.prepare(
          'SELECT count(*) as n FROM contacts WHERE deleted_at IS NULL'
        ).get().n,
        deals: db.prepare(
          'SELECT count(*) as n FROM deals WHERE deleted_at IS NULL'
        ).get().n,
        interactions_7d: db.prepare(
          "SELECT count(*) as n FROM interactions WHERE date > datetime('now', '-7 days')"
        ).get().n,
        last_interaction: db.prepare(
          'SELECT max(date) as d FROM interactions'
        ).get().d,
      };
      db.close();
    } catch {}

    return {
      id: clientId,
      status: proc.pm2_env.status,
      memory_mb: Math.round((proc.monit?.memory || 0) / 1024 / 1024),
      cpu: proc.monit?.cpu || 0,
      uptime: proc.pm2_env.pm_uptime,
      restarts: proc.pm2_env.restart_time,
      ...stats,
    };
  });

  res.json(clients);
});

// ─── Explorer les tables d'un client ───
app.get('/api/admin/clients/:id/db', requireAdmin, (req, res) => {
  const dbPath = `/opt/otto/clients/${req.params.id}/groups/main/business.db`;
  const db = new Database(dbPath, { readonly: true });
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all();
  db.close();
  res.json({ tables });
});

// ─── Requête SQL en lecture seule ───
app.post('/api/admin/clients/:id/query', requireAdmin, (req, res) => {
  const { sql } = req.body;

  // Bloquer les écritures
  if (/INSERT|UPDATE|DELETE|DROP|ALTER|CREATE/i.test(sql)) {
    return res.status(403).json({ error: 'Lecture seule' });
  }

  const dbPath = `/opt/otto/clients/${req.params.id}/groups/main/business.db`;
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(sql).all();
    db.close();
    res.json({ rows, count: rows.length });
  } catch (err) {
    db.close();
    res.status(400).json({ error: err.message });
  }
});

// ─── Lister les documents d'un client ───
app.get('/api/admin/clients/:id/documents', requireAdmin, (req, res) => {
  const dbPath = `/opt/otto/clients/${req.params.id}/groups/main/business.db`;
  const db = new Database(dbPath, { readonly: true });
  const docs = db.prepare(
    `SELECT id, title, category, file_type, file_path, created_at
     FROM documents WHERE deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 50`
  ).all();
  db.close();
  res.json(docs);
});

// ─── Télécharger un document ───
app.get('/api/admin/clients/:id/documents/:docId/download', requireAdmin, (req, res) => {
  const dbPath = `/opt/otto/clients/${req.params.id}/groups/main/business.db`;
  const db = new Database(dbPath, { readonly: true });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.docId);
  db.close();

  if (!doc) return res.status(404).json({ error: 'Document introuvable' });

  const filePath = `/opt/otto/clients/${req.params.id}/groups/main/${doc.file_path}`;
  res.download(filePath);
});

// ─── Voir le CLAUDE.md et les mémoires ───
app.get('/api/admin/clients/:id/memory', requireAdmin, (req, res) => {
  const basePath = `/opt/otto/clients/${req.params.id}/groups/main`;
  const claudeMd = fs.readFileSync(`${basePath}/CLAUDE.md`, 'utf8');

  let memoryFiles = {};
  const memoryDir = `${basePath}/memory`;
  if (fs.existsSync(memoryDir)) {
    for (const file of fs.readdirSync(memoryDir, { recursive: true })) {
      const fullPath = path.join(memoryDir, file.toString());
      if (fs.statSync(fullPath).isFile()) {
        memoryFiles[file.toString()] = fs.readFileSync(fullPath, 'utf8');
      }
    }
  }

  res.json({ claudeMd, memoryFiles });
});

// ─── Voir l'audit log ───
app.get('/api/admin/clients/:id/audit', requireAdmin, (req, res) => {
  const dbPath = `/opt/otto/clients/${req.params.id}/groups/main/business.db`;
  const db = new Database(dbPath, { readonly: true });
  const logs = db.prepare(
    'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100'
  ).all();
  db.close();
  res.json(logs);
});

// ─── Logs PM2 d'un client ───
app.get('/api/admin/clients/:id/logs', requireAdmin, (req, res) => {
  const logs = execSync(
    `pm2 logs otto-${req.params.id} --lines 100 --nostream 2>&1`
  ).toString();
  res.json({ logs });
});

// ─── Coûts API Anthropic (tous les clients) ───
app.get('/api/admin/costs', requireAdmin, async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const response = await fetch(
    `https://api.anthropic.com/v1/organizations/cost_report?` +
    `starting_at=${startOfMonth}&ending_at=${now.toISOString()}&group_by[]=workspace_id`,
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_ADMIN_KEY!,
        'anthropic-version': '2023-06-01',
      }
    }
  );
  res.json(await response.json());
});

// ─── Actions ───
app.post('/api/admin/clients/:id/restart', requireAdmin, (req, res) => {
  execSync(`pm2 restart otto-${req.params.id}`);
  res.json({ ok: true });
});

app.post('/api/admin/clients/:id/stop', requireAdmin, (req, res) => {
  execSync(`pm2 stop otto-${req.params.id}`);
  res.json({ ok: true });
});
```

### Plan du back-office

```
otto.hntic.fr/admin
│
├── /admin/                                → Dashboard : liste clients, statuts, coûts globaux
│
├── /admin/clients/:id                     → Fiche client
│   ├── Statut PM2 (online/stopped/errored)
│   ├── RAM / CPU / uptime / restarts
│   ├── Stats business (contacts, deals, interactions/7j)
│   └── Dernière activité
│
├── /admin/clients/:id/db                  → Explorer les tables SQLite
├── /admin/clients/:id/query               → Requête SQL libre (lecture seule)
├── /admin/clients/:id/documents           → Liste des pièces jointes
├── /admin/clients/:id/documents/:id       → Télécharger un fichier
├── /admin/clients/:id/memory              → CLAUDE.md + fichiers memory/
├── /admin/clients/:id/audit               → Journal d'audit (qui a modifié quoi)
├── /admin/clients/:id/logs                → Logs PM2 (100 dernières lignes)
│
├── /admin/costs                           → Coûts API Anthropic par workspace/client
│
└── Actions
    ├── Restart un client
    ├── Stopper un client
    └── (Dé-provisionner via webhook Stripe, pas via admin)
```

### Frontend

Une page React simple ou même du HTML/JS brut qui consomme les routes API ci-dessus. Servie par `otto-api` comme fichier statique. Pas besoin de framework — c'est un outil interne pour toi seul.

L'accès est protégé par un `ADMIN_TOKEN` dans le `.env` de l'API. Passé en header `x-admin-token` par le frontend. Pour y accéder, soit une extension navigateur (ModHeader), soit un simple formulaire de login qui stocke le token en `sessionStorage`.