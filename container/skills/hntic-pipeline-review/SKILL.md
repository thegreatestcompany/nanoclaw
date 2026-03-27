---
name: hntic-pipeline-review
description: Revue du pipeline commercial avec scoring de santé des deals. Se déclenche sur "pipeline", "mes deals", "où j'en suis commercialement", "point commercial", "revue pipeline", "forecast", "prévisions".
---

# Revue du pipeline commercial

Analyse le pipeline, score la santé de chaque deal, et propose un plan d'action.

## Données

Via `query_business_db` :

```sql
-- Deals actifs avec contexte
SELECT d.*, c.name as contact_name, co.name as company_name,
  (SELECT MAX(date) FROM interactions WHERE deal_id = d.id) as last_activity,
  (SELECT COUNT(*) FROM interactions WHERE deal_id = d.id) as interaction_count
FROM deals d
LEFT JOIN contacts c ON d.contact_id = c.id
LEFT JOIN companies co ON d.company_id = co.id
WHERE d.stage NOT IN ('won','lost') AND d.deleted_at IS NULL
ORDER BY d.expected_close_date ASC

-- Historique récent pour contexte
SELECT d.title, i.summary, i.date FROM interactions i
JOIN deals d ON i.deal_id = d.id
WHERE d.stage NOT IN ('won','lost') AND i.date > date('now', '-30 days')
ORDER BY i.date DESC LIMIT 20
```

## Scoring de santé

Pour chaque deal, calcule un score (A/B/C/D) basé sur :

| Facteur | Poids | A (sain) | B (attention) | C (à risque) | D (critique) |
|---------|-------|----------|---------------|---------------|--------------|
| Dernière activité | 30% | < 7j | 7-14j | 14-30j | > 30j |
| Taille du deal | 25% | > 20K€ | 10-20K€ | 5-10K€ | < 5K€ |
| Avancement stage | 20% | negotiation | proposal | qualified | lead |
| Proximité close | 15% | cette semaine | ce mois | ce trimestre | pas de date |
| Nombre interactions | 10% | > 5 | 3-5 | 1-2 | 0 |

## Format de sortie

```
*Revue pipeline — {date}*

*Vue d'ensemble*
• Pipeline total : {somme}€ ({nombre} deals)
• Pondéré (probabilité) : {somme pondérée}€
• Closing ce mois : {somme}€
• Deals à risque : {nombre}

*Deals par score*

🟢 *Score A — En bonne voie*
• {Deal} — {montant}€ — {stage} — Close {date}
  ↳ Dernière activité : {date} — {résumé}

🟡 *Score B — À surveiller*
• {Deal} — {montant}€ — {stage}
  ↳ {raison du score B} — _Action : {suggestion}_

🟠 *Score C — À risque*
• {Deal} — {montant}€ — {stage}
  ↳ {raison du score C} — _Action : {suggestion}_

🔴 *Score D — Critique*
• {Deal} — {montant}€ — {stage}
  ↳ {raison du score D} — _Action : {suggestion}_

*Actions de la semaine*
1. {Action prioritaire}
2. {Action}
3. {Action}
```

## Forecast

Si le dirigeant demande "combien je vais facturer" ou "forecast" :

```sql
-- Réalisé (factures payées)
SELECT SUM(amount) FROM invoices
WHERE direction = 'outbound' AND status = 'paid'
AND paid_date >= date('now', 'start of month')

-- En attente (factures envoyées)
SELECT SUM(amount) FROM invoices
WHERE direction = 'outbound' AND status = 'sent'

-- Pipeline pondéré
SELECT SUM(amount * probability / 100.0) FROM deals
WHERE stage NOT IN ('won','lost') AND deleted_at IS NULL
AND expected_close_date <= date('now', '+3 months')
```

Format :
```
*Forecast Q{trimestre}*

• Facturé ce mois : {montant}€
• En attente de paiement : {montant}€
• Pipeline pondéré (3 mois) : {montant}€
• Total prévisionnel : {somme}€
```
