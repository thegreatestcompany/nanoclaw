# TODO — Otto by HNTIC

## À faire

### Passive scanner opt-in
Le channel WhatsApp ne transmet actuellement que les messages des chats enregistrés. Pour que le passive scanner fonctionne, il faut :
1. Modifier le channel WhatsApp pour transmettre aussi les messages des JIDs présents dans `scan_config` (mode `listen` ou `active`)
2. Ajouter une commande pour que le dirigeant puisse dire "scanne cette conversation" → insert dans `scan_config`
3. Le passive scanner analyse ensuite ces conversations toutes les 2h avec Haiku
4. Approche opt-in uniquement (pas de stockage par défaut → RGPD)

### Gmail OAuth automatisé
L'intégration Gmail est actuellement manuelle (copie de credentials via scp). Pour l'onboarding self-service :
1. Créer un projet GCP unique avec consent screen vérifié (HNTIC)
2. Ajouter un flow OAuth dans l'API d'onboarding (redirection → callback → stockage tokens)
3. Le client clique un lien, autorise Gmail, et c'est configuré automatiquement
4. Refresh token stocké dans le dossier client, monté dans le container
