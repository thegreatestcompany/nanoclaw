---
name: hntic-session-learnings
description: Extrait les informations nouvelles apprises pendant une session et les stocke en mémoire persistante. Exécuté automatiquement en fin de session interactive (pas les tâches schedulées).
user-invocable: false
---

# Extraction des learnings de session

Tu reçois un résumé de la conversation qui vient de se terminer. Ta mission : identifier ce qui doit être mémorisé pour les futures sessions.

## Ce que tu cherches

| Type | Exemple | Où stocker |
|------|---------|------------|
| Correction | "Non, c'est 55K pas 45K" | Mettre à jour le deal dans business.db |
| Préférence | "Tutoie-moi", "Envoie les digests à 6h30" | memory/context/preferences.md + CLAUDE.md |
| Nouveau contact fréquent | Mentionné 3+ fois dans la session | CLAUDE.md section Contacts fréquents |
| Nouvel acronyme | "PSR = Pipeline Status Report" | memory/glossary.md + CLAUDE.md section Acronymes |
| Décision stratégique | "On arrête le projet X" | business.db table decisions |
| Pattern de correction | "Quand je dis Marc, c'est mon ami" | CLAUDE.md section Notes et corrections |
| Info entreprise | "On a 12 salariés", "On est basé à Lyon" | memory/context/company.md |

## Instructions

1. Analyse la conversation résumée
2. Pour chaque info nouvelle trouvée :
   a. Détermine le type (voir tableau ci-dessus)
   b. Vérifie si l'info existe déjà (query business.db ou lire les fichiers memory/)
   c. Si c'est nouveau → stocke dans le bon endroit
   d. Si c'est une mise à jour → mets à jour l'existant
3. Si le CLAUDE.md doit être mis à jour (nouveau contact fréquent, acronyme, correction), fais-le
4. Garde le CLAUDE.md sous 80 lignes — si ça dépasse, déplace les infos les moins récentes vers memory/

## Règles

- Ne stocke PAS les détails de la conversation elle-même (déjà archivé par le hook PreCompact)
- Ne stocke PAS les infos éphémères ("rappelle-moi à 14h" — c'est une tâche, pas une mémoire)
- Sois concis — une ligne par info, pas de phrase complète
- Si rien de nouveau n'a été appris, ne fais rien (pas de modification inutile)

## Format de sortie

Résume ce que tu as mémorisé en une ligne pour les logs :

```
[LEARNINGS] 2 nouvelles infos : préférence tutoiement, acronyme PSR
```

ou

```
[LEARNINGS] Rien de nouveau à mémoriser
```
