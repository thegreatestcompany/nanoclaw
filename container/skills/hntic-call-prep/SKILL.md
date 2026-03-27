---
name: hntic-call-prep
description: Brief de préparation avant un rendez-vous ou un appel. Se déclenche sur "prépare mon rdv avec", "brief pour", "prépare mon appel avec", "je vois X demain/aujourd'hui", "brief-moi sur".
---

# Préparation de rendez-vous

Génère un brief concis (5-10 lignes) avant un appel ou une réunion avec un contact business.

## Données à rassembler

Via `query_business_db`, en une série de requêtes ciblées :

```sql
-- 1. Le contact
SELECT * FROM contacts WHERE name LIKE '%{nom}%' AND deleted_at IS NULL

-- 2. Son entreprise
SELECT * FROM companies WHERE id = '{company_id}'

-- 3. Les deals liés
SELECT * FROM deals WHERE (contact_id = '{id}' OR company_id = '{company_id}')
  AND deleted_at IS NULL ORDER BY updated_at DESC

-- 4. Les dernières interactions (5 max)
SELECT summary, date, type FROM interactions
WHERE contact_id = '{id}' ORDER BY date DESC LIMIT 5

-- 5. Le résumé de la relation
SELECT * FROM relationship_summaries WHERE contact_id = '{id}'
  ORDER BY last_updated DESC LIMIT 1

-- 6. Factures en cours avec cette entreprise
SELECT status, amount, due_date FROM invoices
WHERE company_id = '{company_id}' AND status NOT IN ('paid','cancelled') AND deleted_at IS NULL

-- 7. Réunions passées
SELECT date, summary, action_items FROM meetings
WHERE related_company_id = '{company_id}' ORDER BY date DESC LIMIT 3
```

## Format du brief

```
*Brief — {Nom du contact} ({Entreprise})*

*Contexte*
{Résumé de la relation en 2-3 phrases : depuis quand on se connaît, quel deal en cours, dernier échange}

*Derniers échanges*
• {date} — {résumé de l'interaction}
• {date} — {résumé}

*Deal en cours*
• {Titre} — {montant}€ — Stade : {stage}
• Prochaine action prévue : {next_action}

*Points d'attention*
• {Facture en retard / engagement non tenu / sujet délicat}

*Suggestions pour le rdv*
• {Suggestion 1 basée sur le contexte}
• {Suggestion 2}
```

## Si le contact n'est pas trouvé

Si `query_business_db` ne retourne rien :
1. Demande au dirigeant : "Je n'ai pas de fiche pour {nom}. Tu peux me donner un peu de contexte ?"
2. Propose de créer la fiche contact après le rdv
3. Si possible, utilise `WebSearch` pour chercher l'entreprise/la personne

## Après le rendez-vous

Si le dirigeant dit "résumé de mon rdv" ou "call summary" :
1. Demande les points clés si pas déjà fournis
2. Stocke dans `interactions` (type: meeting, summary, date)
3. Met à jour le deal si le stade a changé
4. Crée les follow-ups nécessaires (next_action, next_action_date sur le deal)
5. Met à jour le `relationship_summary` du contact
6. Confirme brièvement : "Noté. Prochaine action : {action} le {date}."
