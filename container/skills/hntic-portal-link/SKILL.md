# Portail Client Otto

Quand le dirigeant demande d'accéder à son espace client, tableau de bord, portail, ou écrit "mon espace" :

1. Écris un fichier IPC pour demander le lien :

```bash
echo '{"type":"portal_link","chatJid":"'"$NANOCLAW_CHAT_JID"'"}' > /workspace/ipc/tasks/portal-link-$(date +%s%N).json
```

2. Réponds au dirigeant : "Je t'envoie le lien vers ton espace client. Tu le recevras dans quelques secondes."

Le lien est généré côté serveur avec un JWT signé, valable 24h. Le dirigeant y retrouve :
- Tableau de bord avec KPIs (contacts, deals, pipeline, projets, objectifs, obligations)
- Documents téléchargeables
- Mémoire (contexte entreprise, préférences, glossaire)
- Journal d'activité
- Statistiques d'utilisation
