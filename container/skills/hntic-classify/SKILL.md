---
name: hntic-classify
description: Classifie les messages business WhatsApp et stocke les entités dans les bonnes tables SQLite. Utilisé en mode scan passif avec le modèle Haiku et pour la classification directe avec Sonnet.
user-invocable: false
---

# Classification business

Quand tu reçois des messages à classifier ou quand le dirigeant te donne une information, applique cette logique.

## Étape 1 — Identification des entités

Pour chaque message ou groupe de messages, extrais :
• Noms de personnes (nouveau contact potentiel ?)
• Noms d'entreprises
• Montants financiers (prix, devis, factures, budgets)
• Dates et échéances
• Actions ou engagements pris ("je t'envoie le devis", "on se rappelle mardi")
• Sentiment général (positif, neutre, négatif)

## Étape 2 — Catégorisation

| Signal dans le message | Table(s) cible |
|------------------------|----------------|
| Nouveau nom + entreprise mentionnés | contacts, companies |
| Montant + contexte de négociation/vente | deals |
| "On se voit mardi", "RDV à 14h" | meetings |
| "Envoie-moi le devis", "Je te fais un retour" | interactions (avec next_action sur le deal) |
| "La facture est payée", montant + référence | invoices |
| "Jean est en congé", "Marie sera absente" | absences |
| Feedback sur un collaborateur, entretien | reviews |
| Document reçu (PDF, image) | documents |
| Décision stratégique, choix d'orientation | decisions |
| Objectif, KPI, target | goals |
| Info fournisseur, prestataire, devis reçu | suppliers |
| Obligation légale, échéance fiscale | obligations |
| Contrat signé, renouvellement, résiliation | contracts |
| Tout le reste qui a de la valeur business | memories |
| Conversation personnelle sans valeur business | (ignorer) |

## Étape 3 — Vérification anti-doublons

AVANT de créer un nouvel enregistrement :

1. *Contacts* : `SELECT id, name FROM contacts WHERE name LIKE '%nom%' AND deleted_at IS NULL`
2. *Entreprises* : `SELECT id, name FROM companies WHERE name LIKE '%nom%' AND deleted_at IS NULL`
3. *Deals* : `SELECT id, title FROM deals WHERE title LIKE '%mot_clé%' AND stage NOT IN ('won','lost') AND deleted_at IS NULL`

Si un enregistrement similaire existe → UPDATE plutôt que INSERT.

## Étape 4 — Stockage

Utilise les MCP tools `mutate_business_db` pour les écritures et `query_business_db` pour les vérifications.

Toujours fournir :
• `table_name` : nom de la table modifiée
• `record_id` : l'ID du record (ou "new" pour un INSERT)
• `reason` : pourquoi ce changement (ex: "message WhatsApp du 15/03")

## Règles de prudence

• Ne crée PAS un contact à partir d'un prénom mentionné en passant dans une conversation informelle ("j'ai croisé Marc au café")
• Ne crée PAS un deal si c'est juste une discussion exploratoire sans montant ni engagement clair
• Ne crée PAS de doublon — toujours vérifier d'abord (étape 3)
• Priorise la mise à jour d'enregistrements existants sur la création de nouveaux
• Les montants doivent être des nombres, pas du texte ("12500" pas "douze mille cinq cents")
• Les dates doivent être au format ISO ("2026-03-15" pas "15 mars")

## Niveaux de confiance

| Confiance | Action |
|-----------|--------|
| > 80 % | Stocke directement, confirme brièvement au dirigeant |
| 50-80 % | Stocke avec `"[À CONFIRMER]"` dans le champ notes |
| < 50 % | Ne stocke PAS, demande confirmation si c'est en conversation directe |

## Après le stockage

• Si un deal a été mis à jour, vérifie si le `next_action` ou `next_action_date` doit changer
• Si un nouveau contact est créé, vérifie s'il faut le rattacher à un deal ou une entreprise existante
• Si une échéance est détectée, vérifie si une obligation similaire existe déjà
