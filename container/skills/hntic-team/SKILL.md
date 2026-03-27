---
name: hntic-team
description: Module RH et gestion d'équipe. Se déclenche sur "mon équipe", "point RH", "qui est absent", "entretien avec", "embauche", "onboarding", "congés", "salaires", "effectifs".
---

# Module équipe / RH

Aide le dirigeant à gérer son équipe au quotidien.

## Point équipe

```sql
-- Effectifs
SELECT name, role, contract_type, start_date FROM team_members
WHERE deleted_at IS NULL ORDER BY name

-- Absences en cours et à venir
SELECT a.*, tm.name FROM absences a
JOIN team_members tm ON a.member_id = tm.id
WHERE a.end_date >= date('now') AND a.start_date <= date('now', '+14 days')
ORDER BY a.start_date

-- Fins de période d'essai proches
SELECT name, trial_end_date FROM team_members
WHERE trial_end_date IS NOT NULL AND trial_end_date <= date('now', '+30 days')
  AND deleted_at IS NULL

-- Affectations projets
SELECT tm.name, p.name as project, a.role FROM assignments a
JOIN team_members tm ON a.member_id = tm.id
JOIN projects p ON a.project_id = p.id
WHERE p.status = 'active' AND (a.end_date IS NULL OR a.end_date >= date('now'))
```

### Format
```
*Point équipe — {date}*

*Effectifs* : {nombre} ({CDI}CDI, {CDD}CDD, {freelance}freelances)

*Absences*
• {Nom} — {type} du {début} au {fin}
• {Nom} — {type} {dates}

*Attention*
• {Nom} — Fin de période d'essai le {date}
• {Nom} — {autre alerte}

*Affectations*
• {Nom} → {Projet} ({rôle})
```

## Préparation d'entretien

Si le dirigeant dit "prépare mon entretien avec {nom}" :

```sql
SELECT * FROM team_members WHERE name LIKE '%{nom}%'
SELECT * FROM reviews WHERE member_id = '{id}' ORDER BY date DESC LIMIT 3
SELECT * FROM assignments a JOIN projects p ON a.project_id = p.id
  WHERE a.member_id = '{id}' AND p.status = 'active'
SELECT summary, date FROM interactions
  WHERE contact_id IN (SELECT id FROM contacts WHERE name LIKE '%{nom}%')
  ORDER BY date DESC LIMIT 5
```

### Format
```
*Entretien — {Nom} ({Poste})*

*Profil*
• Arrivée : {date} — {type de contrat}
• Salaire : {montant}€
• Projets actuels : {liste}

*Historique des entretiens*
• {date} — {résumé}

*Points à aborder*
• {suggestion basée sur les données}
```

## Onboarding

Si le dirigeant dit "j'embauche quelqu'un" ou "onboarding" :

1. Créer une fiche `team_members`
2. Créer les obligations associées :
   - DPAE (avant l'embauche)
   - Contrat de travail (jour 1)
   - Visite médicale (dans les 3 mois)
   - Mutuelle (dans le mois)
   - Fin de période d'essai (date calculée)
3. Proposer une checklist d'onboarding adaptée au poste

## Gestion des congés

Quand le dirigeant dit "{nom} est en congé du X au Y" :
1. Vérifier que le membre existe dans `team_members`
2. Créer une entrée `absences`
3. Vérifier s'il y a des conflits avec des projets ou réunions
4. Confirmer : "Noté. {Nom} en congé du {début} au {fin}."
