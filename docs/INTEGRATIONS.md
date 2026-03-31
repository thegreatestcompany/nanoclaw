# Intégrations Otto — Guide Composio

## Vue d'ensemble

Otto utilise [Composio](https://composio.dev) pour connecter les clients à leurs apps tierces (Gmail, Google Calendar, HubSpot, Notion, Slack, etc.). Composio gère l'OAuth, le refresh des tokens, et expose 980+ apps comme outils MCP.

## Architecture

```
Client WhatsApp : "Lis mes emails"
    ↓
Otto (container Docker)
    ↓
Composio SDK (in-process, même process Node.js)
    ↓
6 meta-tools chargés au démarrage (~2-3K tokens)
    ↓
COMPOSIO_SEARCH_TOOLS → cherche "email" côté serveur Composio
    ↓
COMPOSIO_MULTI_EXECUTE_TOOL → exécute GMAIL_FETCH_EMAILS via API Composio
    ↓
Résultat renvoyé à Otto → envoyé au client sur WhatsApp
```

### Pourquoi in-process et pas HTTP remote

| | In-process (actuel) | HTTP remote |
|---|---|---|
| Setup | `createSdkMcpServer({ tools })` | `{ type: 'http', url: session.mcp.url }` |
| Latence | Plus rapide (pas de réseau pour la découverte) | Chaque appel passe par le réseau |
| Dépendances | `@composio/core` + `@composio/claude-agent-sdk` dans le container | Aucune dep dans le container |
| Tokens | 6 meta-tools (~2-3K tokens) | Idem |

### Les 6 meta-tools

| Tool | Rôle | Quand |
|------|------|-------|
| `COMPOSIO_SEARCH_TOOLS` | Recherche sémantique d'outils par intent | "envoyer email", "créer événement" |
| `COMPOSIO_GET_TOOL_SCHEMAS` | Récupère le schéma d'un outil spécifique | Avant d'exécuter un outil inconnu |
| `COMPOSIO_MULTI_EXECUTE_TOOL` | Exécute une ou plusieurs actions | Envoyer email, lire calendar, etc. |
| `COMPOSIO_MANAGE_CONNECTIONS` | Gère l'auth OAuth (génère les liens) | Quand une app n'est pas connectée |
| `COMPOSIO_REMOTE_BASH_TOOL` | Bash dans un sandbox Composio | Non utilisé par Otto |
| `COMPOSIO_REMOTE_WORKBENCH` | Workbench Composio | Non utilisé par Otto |

Les schémas des 980 apps ne sont **jamais** chargés dans le context Claude. L'agent cherche par intent → Composio retourne le bon outil → l'agent l'exécute. Coût en tokens minimal.

## Flow OAuth (via WhatsApp)

```
1. Client : "Connecte mon Gmail"
        ↓
2. Otto appelle COMPOSIO_MANAGE_CONNECTIONS avec toolkits=["gmail"]
        ↓
3. Composio retourne un lien : https://connect.composio.dev/link/lk_xxx
        ↓
4. Otto envoie le lien sur WhatsApp
        ↓
5. Client clique → navigateur → Google OAuth → autorise
        ↓
6. Composio stocke le token, refresh automatique
        ↓
7. Client revient sur WhatsApp : "C'est fait"
        ↓
8. Otto exécute l'action (GMAIL_FETCH_EMAILS, etc.)
```

### Mauvais compte connecté

Le client peut déconnecter et reconnecter :
- Otto appelle `COMPOSIO_MANAGE_CONNECTIONS` avec `toolkits=["gmail"]`
- Un nouveau lien est généré
- Le client se reconnecte avec le bon compte

### Tokens OAuth

- Composio gère le refresh automatiquement
- Pas besoin de stocker des tokens côté Otto
- Chaque client a ses propres credentials (isolé par `user_id` = `chatJid`)

## Configuration

### Variables d'environnement

| Variable | Où | Valeur |
|----------|-----|--------|
| `COMPOSIO_API_KEY` | Client `.env` + container env | `ak_xxx` (depuis platform.composio.dev) |

Le host passe `COMPOSIO_API_KEY` au container Docker via `-e COMPOSIO_API_KEY=xxx` (dans `container-runner.ts`).

### Code (container/agent-runner/src/index.ts)

```typescript
// Initialisation au démarrage du container
const { Composio } = await import('@composio/core');
const { ClaudeAgentSDKProvider } = await import('@composio/claude-agent-sdk');

const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,
  provider: new ClaudeAgentSDKProvider(),
});
const session = await composio.create(containerInput.chatJid); // user_id = numéro WhatsApp
const tools = await session.tools();

const composioServer = createSdkMcpServer({
  name: 'composio',
  version: '1.0.0',
  tools,
});

// Ajouté dans mcpServers de query()
mcpServers: {
  composio: composioServer,
  // ... autres servers
}
```

### Fallback

Quand `COMPOSIO_API_KEY` n'est pas configuré, les anciens MCP servers Gmail/Calendar locaux sont utilisés (nécessitent des tokens OAuth manuels dans `.gmail-mcp/`).

## OAuth Credentials

### Credentials partagés Composio (dev/test)

Par défaut, Composio utilise ses propres credentials OAuth. L'écran d'autorisation dit "Composio veut accéder à votre Gmail". Suffisant pour tester.

### Credentials custom (production)

Pour la prod, créer ses propres credentials dans Google Cloud Console et les configurer dans Composio :

1. **Google Cloud Console** → APIs & Services → Credentials
2. Créer un OAuth Client ID (type: Web application)
3. Redirect URI : fourni par Composio
4. **Dashboard Composio** → Auth Configs → Gmail → Custom OAuth
5. Entrer `client_id` et `client_secret`
6. L'écran d'autorisation dira "Otto by HNTIC veut accéder à votre Gmail"

## Ajouter une nouvelle intégration

Pour ajouter une app (ex: HubSpot, Notion, Slack) :

### Rien à coder

L'agent découvre les outils automatiquement via `COMPOSIO_SEARCH_TOOLS`. Il suffit que le client connecte son compte :

```
Client : "Ajoute ce contact dans HubSpot"
    ↓
Otto : COMPOSIO_SEARCH_TOOLS("add contact to HubSpot")
    ↓
Composio : "Utilise HUBSPOT_CREATE_CONTACT"
    ↓
Otto : COMPOSIO_MULTI_EXECUTE_TOOL("HUBSPOT_CREATE_CONTACT", {...})
    ↓
"HubSpot n'est pas connecté" → lien OAuth envoyé
    ↓
Client connecte → Otto retente → contact créé
```

### Si OAuth custom est nécessaire

1. Créer l'app dans le dashboard de l'intégration (HubSpot Developer, Notion API, etc.)
2. Récupérer `client_id` + `client_secret`
3. Dashboard Composio → Auth Configs → [App] → Custom OAuth
4. Configurer le redirect URI

### Limiter les tools exposés

Si besoin de restreindre les actions disponibles (ex: pas de suppression d'emails) :

```typescript
// Dans la création du MCP server Composio (via l'API)
const server = await composio.mcp.create("otto-restricted", {
  toolkits: [{ toolkit: "gmail" }],
  allowedTools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL", "GMAIL_CREATE_DRAFT"],
});
```

## Apps testées

| App | Statut | Notes |
|-----|--------|-------|
| Gmail | ✅ Testé | Lire, envoyer, brouillons |
| Google Calendar | 🔲 À tester | Événements, rappels |
| HubSpot | 🔲 À tester | CRM, contacts, deals |
| Notion | 🔲 À tester | Pages, bases de données |
| Slack | 🔲 À tester | Messages, channels |
| Google Drive | 🔲 À tester | Fichiers, partage |
| Google Sheets | 🔲 À tester | Lecture, écriture |

## Coûts

### Composio

| Plan | Tool calls/mois | Prix |
|------|----------------|------|
| Free | 20K | $0 |
| Starter | 200K | $29/mois |
| Business | 2M | $229/mois |

### Tokens Claude

Le surcoût en tokens par rapport à une query normale est minimal :
- 6 meta-tools dans le system prompt : ~2-3K tokens (fixe)
- 1 SEARCH_TOOLS : ~500 tokens de réponse
- 1 EXECUTE_TOOL : ~200 tokens + résultat
- Total par action : ~1-2K tokens supplémentaires (~$0.01)

## Troubleshooting

| Problème | Solution |
|----------|----------|
| "No active connection for toolkit" | Le client doit connecter l'app via le lien OAuth |
| "Composio init failed" | Vérifier `COMPOSIO_API_KEY` dans le `.env` du client |
| Lien OAuth expiré | Redemander → nouveau lien généré automatiquement |
| Token refresh échoué | Composio gère ça automatiquement — si ça persiste, reconnecter |
| Tool non trouvé | Vérifier le nom exact avec `composio search "xxx"` |

## Références

- [Doc Composio — Claude Agent SDK](https://docs.composio.dev/docs/providers/claude-agent-sdk)
- [Doc Composio — Native Tools vs MCP](https://docs.composio.dev/docs/native-tools-vs-mcp)
- [Doc Composio — Single Toolkit MCP](https://docs.composio.dev/docs/single-toolkit-mcp)
- [Doc Composio — CLI](https://docs.composio.dev/docs/cli)
- [Doc Composio — Auth](https://docs.composio.dev/auth/your-users)
- [Dashboard Composio](https://platform.composio.dev)
