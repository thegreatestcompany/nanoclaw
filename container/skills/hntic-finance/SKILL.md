---
name: hntic-finance
description: Module financier du dirigeant. Se déclenche sur "point tréso", "trésorerie", "combien j'ai", "factures", "dépenses", "point financier", "CA", "chiffre d'affaires", "marge", "charges".
---

# Module financier

Répond aux questions financières du dirigeant à partir des données en base.

## Requêtes types

### Point trésorerie

```sql
-- Factures émises (CA)
SELECT SUM(amount) as total, status FROM invoices
WHERE direction = 'outbound' AND deleted_at IS NULL
  AND issue_date >= date('now', 'start of month')
GROUP BY status

-- Factures reçues (charges)
SELECT SUM(amount) as total, status FROM invoices
WHERE direction = 'inbound' AND deleted_at IS NULL
  AND issue_date >= date('now', 'start of month')
GROUP BY status

-- Dépenses du mois
SELECT category, SUM(amount) as total FROM expenses
WHERE date >= date('now', 'start of month')
GROUP BY category ORDER BY total DESC

-- Masse salariale
SELECT SUM(salary) as total_salaires FROM team_members
WHERE deleted_at IS NULL AND contract_type IN ('cdi','cdd')
```

### Factures en retard

```sql
SELECT i.*, co.name as company_name,
  julianday('now') - julianday(i.due_date) as jours_retard
FROM invoices i
LEFT JOIN companies co ON i.company_id = co.id
WHERE i.status = 'overdue' AND i.direction = 'outbound' AND i.deleted_at IS NULL
ORDER BY jours_retard DESC
```

### Analyse des dépenses

```sql
SELECT category, SUM(amount) as total,
  COUNT(*) as nb_depenses
FROM expenses
WHERE date >= date('now', '-3 months')
GROUP BY category ORDER BY total DESC
```

## Formats de sortie

### Point tréso
```
*Point trésorerie — {mois}*

*Entrées*
• Facturé : {total émis}€
• Encaissé : {total payé}€
• En attente : {total envoyé non payé}€

*Sorties*
• Fournisseurs : {total factures reçues}€
• Dépenses : {total dépenses}€
• Salaires : {total masse salariale}€

*Solde estimé*
• Encaissé - Payé : {différence}€
• À encaisser : {en attente}€

_Attention : {nombre} facture(s) en retard pour {montant total}€_
```

### Relances à faire
```
*Factures à relancer*

• {Entreprise} — {montant}€ — {jours} jours de retard
  ↳ Facture n°{numéro} du {date}
• {Entreprise} — {montant}€ — {jours} jours
```

## Comparaison mois/mois

Si le dirigeant demande "pourquoi mes dépenses ont augmenté" :

```sql
-- Mois en cours vs mois précédent
SELECT category,
  SUM(CASE WHEN date >= date('now', 'start of month') THEN amount ELSE 0 END) as ce_mois,
  SUM(CASE WHEN date >= date('now', 'start of month', '-1 month')
    AND date < date('now', 'start of month') THEN amount ELSE 0 END) as mois_precedent
FROM expenses
WHERE date >= date('now', 'start of month', '-1 month')
GROUP BY category
HAVING ce_mois > 0 OR mois_precedent > 0
ORDER BY ce_mois DESC
```

Format :
```
*Évolution des dépenses*

• {Catégorie} : {ce mois}€ vs {mois dernier}€ ({+/-}%)
• {Catégorie} : {ce mois}€ vs {mois dernier}€
```
