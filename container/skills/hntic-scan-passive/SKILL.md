---
name: hntic-scan-passive
description: Scanne les conversations WhatsApp non traitées et extrait les entités business. Exécuté en mode cron avec le modèle Haiku. S'active quand le prompt contient [SCHEDULED TASK] et des messages à classifier.
user-invocable: false
---

# Scan passif

Tu reçois un batch de messages WhatsApp non traités provenant de conversations écoutées.
Ta mission : extraire les informations business et les stocker dans la base SQLite.

## Instructions

1. Lis le batch de messages fourni
2. Pour chaque conversation (groupée par chat_jid) :
   a. Vérifie que le chat n'est pas en mode `ignore` : `SELECT mode FROM scan_config WHERE chat_jid = ?`
   b. Identifie les entités business (voir skill hntic-classify)
   c. Classe chaque entité avec un score de confiance (0-1)
   d. Si confiance > 0.8 : stocke directement via `mutate_business_db`
   e. Si confiance 0.5-0.8 : stocke avec `"[À CONFIRMER]"` dans le champ notes
   f. Si confiance < 0.5 : ignore (trop incertain pour le scan passif)
3. Après le stockage, mets à jour le `relationship_summary` du contact si applicable
4. À la fin, produis un résumé concis de ce qui a été extrait (pour les logs)

## Règle INSERT vs UPDATE — CRITIQUE

En mode scan passif, tu ne peux que **créer** (INSERT), jamais **modifier** (UPDATE) ni **supprimer** (DELETE) des enregistrements existants.

Si tu détectes qu'un enregistrement existant devrait être mis à jour (ex: un deal qui change de stage, un montant qui évolue, un contact qui change de rôle) :

→ **Ne fais PAS l'UPDATE**. À la place :

1. Vérifie qu'un pending_update identique n'existe pas déjà (y compris ceux déjà refusés — ne pas harceler le dirigeant) :
```sql
SELECT id, status FROM pending_updates
WHERE target_table = 'deals' AND target_id = 'abc123' AND field_name = 'stage' AND new_value = 'won'
  AND status IN ('pending', 'dismissed')
```
→ S'il existe (pending ou dismissed) : **ne rien faire**

2. S'il existe un ancien pending sur le même champ avec une `new_value` différente, remplace-le (la nouvelle info est plus récente) :
```sql
UPDATE pending_updates SET status = 'superseded'
WHERE target_table = 'deals' AND target_id = 'abc123' AND field_name = 'stage' AND status = 'pending'
```

3. Seulement alors, INSERT :
```sql
INSERT INTO pending_updates (target_table, target_id, field_name, old_value, new_value, source_chat_jid, source_message, confidence)
VALUES ('deals', 'abc123', 'stage', 'negotiation', 'won', '120363408526509003@g.us', 'Super, le client Dupont a signé !', 0.9);
```

Ces mises à jour en attente seront présentées au dirigeant pour validation lors de sa prochaine interaction avec Otto.

## Ce que tu fais

• Extraire des noms de personnes et d'entreprises mentionnés dans un contexte business → INSERT
• Détecter des montants financiers (devis, factures, budgets, salaires) → INSERT
• Repérer des dates et échéances (livraisons, réunions, deadlines) → INSERT
• Identifier des engagements ou actions à suivre → INSERT
• Détecter des changements de statut (deal gagné/perdu, paiement reçu, contrat signé) → `pending_updates`

## Ce que tu ne fais PAS

• Tu ne RÉPONDS PAS aux messages (mode passif uniquement)
• Tu ne crées PAS de doublons (vérifie toujours avant d'insérer)
• Tu ne stockes PAS les conversations personnelles (respecte scan_config.mode)
• Tu ne fais JAMAIS d'UPDATE ni de DELETE sur les tables business (contacts, deals, invoices, etc.) — utilise `pending_updates` à la place
• Exception : `relationship_summaries`, `memories`, `scan_config` peuvent être UPDATE librement (tables auto-gérées)
• Tu ne contactes PAS le dirigeant — tu travailles silencieusement
• Tu n'extrais PAS d'information de messages très courts (< 5 mots) sauf s'ils contiennent un montant ou une date

## Optimisation des coûts

Tu tournes sur Haiku pour minimiser les coûts. Sois efficace :

• Ne fais PAS de requêtes SQL superflues — regroupe les vérifications
• Si un batch ne contient que des messages courts ("ok", "merci", emojis), termine immédiatement sans requête
• Si un chat a déjà été classifié dans `scan_config` comme `personal`, saute-le immédiatement
• Limite-toi à 3-5 requêtes SQL par conversation scannée

## Format du résumé de fin

```
[SCAN PASSIF] {date}
• {N} conversations scannées
• {M} entités extraites : {détail par type}
• {K} enregistrements à confirmer
• Temps estimé : {durée}
```

## Nettoyage

À la fin de chaque scan, supprime les pending_updates traités depuis plus de 30 jours :
```sql
DELETE FROM pending_updates WHERE status IN ('applied', 'dismissed', 'superseded') AND created_at < datetime('now', '-30 days')
```

## Gestion de scan_config

Si tu rencontres une conversation qui n'est pas dans `scan_config` :
1. Analyse le nom du chat et les 5 derniers messages
2. Classifie comme `client`, `team`, `supplier`, `personal`, ou `unknown`
3. Insère dans `scan_config` avec `mode = 'listen'` (sauf `personal` → `mode = 'ignore'`) et `classified_by = 'auto'`
