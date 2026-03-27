---
name: hntic-daily-briefing
description: Briefing quotidien et hebdomadaire pour le dirigeant. Se déclenche sur "briefing", "point du jour", "point de la semaine", "qu'est-ce que j'ai aujourd'hui", "résumé", "digest", "Monday briefing", "flash du matin".
---

# Briefing du dirigeant

Génère un briefing priorisé de l'activité business. Fonctionne en deux modes :
- *Flash quotidien* : ce qui compte aujourd'hui (3-5 min de lecture)
- *Briefing hebdo* : vue d'ensemble de la semaine (lundi matin)

## Sources de données

Toutes les données viennent de la business.db via `query_business_db` :

```
1. Réunions du jour/semaine
   SELECT * FROM meetings WHERE date(date) BETWEEN date('now') AND date('now', '+1 day') ORDER BY date

2. Deals urgents
   SELECT d.*, c.name as contact_name FROM deals d
   LEFT JOIN contacts c ON d.contact_id = c.id
   WHERE d.stage NOT IN ('won','lost') AND d.deleted_at IS NULL
   ORDER BY d.expected_close_date ASC

3. Factures en retard
   SELECT i.*, co.name as company_name FROM invoices i
   LEFT JOIN companies co ON i.company_id = co.id
   WHERE i.status = 'overdue' AND i.deleted_at IS NULL

4. Obligations proches
   SELECT * FROM obligations
   WHERE due_date BETWEEN date('now') AND date('now', '+7 days')
   AND status = 'pending' AND deleted_at IS NULL

5. Deals sans activité (stale)
   SELECT d.*, c.name as contact_name,
     (SELECT MAX(date) FROM interactions WHERE deal_id = d.id) as last_activity
   FROM deals d
   LEFT JOIN contacts c ON d.contact_id = c.id
   WHERE d.stage NOT IN ('won','lost') AND d.deleted_at IS NULL
   HAVING last_activity < date('now', '-7 days') OR last_activity IS NULL

6. Absences équipe
   SELECT a.*, tm.name FROM absences a
   JOIN team_members tm ON a.member_id = tm.id
   WHERE a.start_date <= date('now') AND a.end_date >= date('now')
```

## Priorisation

```
Ordre de priorité :
1. URGENT : deal qui close aujourd'hui/demain pas encore gagné
2. URGENT : facture en retard > 30 jours
3. HAUT : réunion aujourd'hui avec deal > 10K€
4. HAUT : obligation légale/fiscale dans les 3 jours
5. MOYEN : deal qui close cette semaine
6. MOYEN : deal stale (7+ jours sans activité)
7. BAS : tâches de la semaine, relances à faire
```

## Format — Flash quotidien

```
*Flash du {jour} {date}*

*Priorité n°1*
{Ce qui compte le plus aujourd'hui et pourquoi}

*Agenda*
• {heure} — {Entreprise} ({type de rdv})
  ↳ {contexte en 1 ligne}
• {heure} — {Entreprise}
  ↳ {contexte}

*Pipeline*
• ⚠ {Deal} — {montant}€, close prévue {date} — {action}
• {Deal} — {montant}€, stade {stage}

*À faire aujourd'hui*
• {Action 1} — {pourquoi maintenant}
• {Action 2}
• {Action 3}
```

## Format — Briefing hebdomadaire (lundi)

```
*Briefing semaine du {date}*

*Chiffres clés*
• Pipeline ouvert : {total}€ ({nombre} deals)
• Closing cette semaine : {total}€
• Factures en attente : {total}€
• Encaissé ce mois : {total}€

*Top 3 priorités*
1. {Priorité} — {action concrète}
2. {Priorité}
3. {Priorité}

*Deals à surveiller*
• {Deal} — {montant}€ — {problème et action}
• {Deal} — {montant}€ — {problème et action}

*Obligations de la semaine*
• {date} — {obligation}
• {date} — {obligation}

*Équipe*
• {Absences prévues}
• {Points d'attention RH}

_Bonne semaine !_
```

## Logique d'exécution

1. Détermine le type de briefing :
   - Si lundi ou si "hebdo/weekly/semaine" dans la demande → briefing hebdomadaire
   - Sinon → flash quotidien

2. Exécute les requêtes SQL ci-dessus (adapter les dates selon le type)

3. Priorise selon le framework ci-dessus

4. Génère le briefing au format WhatsApp (voir skill hntic-whatsapp-format)

5. Si le briefing dépasse 15 lignes, découpe en 2 messages via `send_message`

## Mode fin de journée

Si le dirigeant dit "récap de la journée" ou "wrap up" :

```
*Récap du {date}*

*Fait aujourd'hui*
• {réunion/action} — {résultat}

*Pipeline — mouvements*
• {Deal} → {nouveau stage}

*Demain*
• {Priorité 1}
• {Priorité 2}

*En attente*
• {chose non résolue qui mérite un suivi}
```
