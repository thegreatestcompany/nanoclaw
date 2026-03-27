---
name: hntic-operations
description: Module opérations et projets. Se déclenche sur "point projet", "status report", "où en est le projet", "mes projets", "risques", "quels sont mes risques", "fournisseurs", "compare ces devis".
---

# Module opérations

Suivi des projets, évaluation des risques, gestion des fournisseurs.

## Status report projet

```sql
-- Projet + budget
SELECT * FROM projects WHERE name LIKE '%{nom}%' AND deleted_at IS NULL

-- Équipe affectée
SELECT tm.name, a.role, a.daily_rate FROM assignments a
JOIN team_members tm ON a.member_id = tm.id
WHERE a.project_id = '{id}' AND (a.end_date IS NULL OR a.end_date >= date('now'))

-- Interactions récentes liées
SELECT summary, date FROM interactions
WHERE project_id = '{id}' ORDER BY date DESC LIMIT 5

-- Réunions liées
SELECT date, summary, action_items FROM meetings
WHERE related_project_id = '{id}' ORDER BY date DESC LIMIT 3
```

### Format
```
*Projet — {Nom}*

*Statut* : {status} | *Budget* : {consumed}/{budget}€ ({%})
*Période* : {début} → {fin}

*Équipe*
• {Nom} — {rôle}

*Dernières activités*
• {date} — {résumé}

*Actions en cours*
• {action}

*Risques*
• {risque identifié}
```

## Vue d'ensemble des risques

Si le dirigeant demande "quels sont mes risques" :

```sql
-- Deals à risque (stale + gros montants)
SELECT title, amount, stage,
  (SELECT MAX(date) FROM interactions WHERE deal_id = deals.id) as last_activity
FROM deals WHERE stage NOT IN ('won','lost') AND deleted_at IS NULL
HAVING last_activity < date('now', '-14 days') OR last_activity IS NULL

-- Obligations en retard
SELECT title, category, due_date FROM obligations
WHERE status = 'overdue' AND deleted_at IS NULL

-- Contrats expirant
SELECT title, end_date, value FROM contracts
WHERE status = 'active' AND end_date <= date('now', '+30 days') AND deleted_at IS NULL

-- Factures en retard (trésorerie)
SELECT SUM(amount) as total, COUNT(*) as nombre FROM invoices
WHERE status = 'overdue' AND direction = 'outbound' AND deleted_at IS NULL

-- Projets dépassant le budget
SELECT name, budget, consumed FROM projects
WHERE status = 'active' AND consumed > budget * 0.9 AND deleted_at IS NULL
```

### Format
```
*Tableau des risques — {date}*

*Commercial*
• {N} deal(s) sans activité > 14 jours — {montant total}€

*Financier*
• {N} facture(s) en retard — {montant}€
• {N} projet(s) proches du dépassement budgétaire

*Juridique*
• {N} obligation(s) en retard
• {N} contrat(s) expirant dans 30 jours

*Recommandations*
1. {Action prioritaire}
2. {Action}
```

## Gestion des fournisseurs

```sql
SELECT * FROM suppliers WHERE deleted_at IS NULL ORDER BY category, name

-- Coûts par fournisseur
SELECT s.name, s.category, SUM(e.amount) as total_depenses
FROM suppliers s
LEFT JOIN expenses e ON e.supplier_id = s.id AND e.date >= date('now', '-12 months')
WHERE s.deleted_at IS NULL
GROUP BY s.id ORDER BY total_depenses DESC
```

## Comparaison de devis

Si le dirigeant dit "compare ces devis" :
1. Extraire les infos de chaque devis (montant, prestations, conditions)
2. Comparer point par point
3. Format :

```
*Comparaison de devis*

• *{Fournisseur A}* — {montant}€
  ↳ {points forts}
  ↳ {points faibles}

• *{Fournisseur B}* — {montant}€
  ↳ {points forts}
  ↳ {points faibles}

*Recommandation* : {choix et justification}
```
