---
name: hntic-memory
description: Architecture mémoire de l'assistant. Gère le stockage, la recherche et la mise à jour des informations apprises sur le dirigeant et son entreprise. S'active automatiquement à chaque interaction.
user-invocable: false
---

# Gestion de la mémoire

## Architecture à 3 niveaux

1. *CLAUDE.md* (mémoire immédiate) — Lu à chaque invocation, 0 requête
   - Les ~30 contacts les plus fréquents
   - Les acronymes et termes métier du dirigeant
   - Les projets actifs
   - Les préférences et corrections apprises

2. *business.db* (mémoire de travail) — Requêtes ciblées
   - Toutes les tables structurées (contacts, deals, factures, etc.)
   - La table `memories` pour les infos non structurées
   - Les `relationship_summaries` pour les synthèses de relations

3. *conversations/* (mémoire long terme) — Sur demande
   - Archives des conversations passées (générées par le hook PreCompact)
   - Contexte historique quand le dirigeant demande "qu'est-ce qu'on s'était dit sur..."

## Flow de recherche

Quand le dirigeant mentionne un nom, un terme, ou un sujet :

```
1. Chercher dans CLAUDE.md (section Contacts clés, Termes, Projets)
   → Si trouvé : utiliser directement, pas de requête

2. Si pas trouvé : chercher dans business.db
   → contacts : SELECT * FROM contacts WHERE name LIKE '%terme%'
   → companies : SELECT * FROM companies WHERE name LIKE '%terme%'
   → memories : SELECT * FROM memories WHERE content LIKE '%terme%' ORDER BY created_at DESC LIMIT 5
   → Si trouvé : répondre et envisager d'ajouter au CLAUDE.md si fréquent

3. Si pas trouvé nulle part : demander au dirigeant
   → "Je ne connais pas '{terme}'. Tu peux me donner un peu de contexte ?"
   → Stocker la réponse dans la bonne table ou dans memories
```

## Quand mettre à jour CLAUDE.md

Mets à jour ce fichier quand :
• Un nouveau contact est mentionné 3+ fois → l'ajouter à la section Contacts
• Le dirigeant utilise un acronyme ou terme métier inconnu → l'ajouter
• Un projet démarre ou se termine → mettre à jour la section Projets
• Le dirigeant corrige l'assistant → noter le pattern pour ne pas refaire l'erreur
• Une préférence est exprimée ("appelle-moi X", "je préfère qu'on se tutoie")

## Format CLAUDE.md — Section dynamique

Ajouter ces sections au CLAUDE.md quand elles se remplissent :

```markdown
## Contacts fréquents

| Nom | Entreprise | Rôle | Contexte |
|-----|-----------|------|----------|
| Jean Dupont | Dupont SARL | DG | Client principal, deal en cours |
| Marie Martin | — | Comptable | Notre cabinet comptable |

## Termes et acronymes

| Terme | Signification |
|-------|--------------|
| PSR | Pipeline Status Report |
| TJM | Taux Journalier Moyen |

## Projets actifs

| Projet | Client | Statut | Note |
|--------|--------|--------|------|
| Refonte site | Dupont SARL | En cours | Livraison prévue avril |

## Notes et corrections

• Quand {dirigeant} dit "Marc", c'est son ami — ne pas créer de fiche contact
• {Dirigeant} préfère le tutoiement
• Ne pas envoyer de messages avant 8h
```

## Relationship summaries

Quand l'assistant a eu plusieurs interactions autour d'un contact, mettre à jour le résumé :

```sql
INSERT OR REPLACE INTO relationship_summaries
  (id, contact_id, company_id, last_updated, summary, key_facts, open_items, sentiment)
VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?)
```

Le résumé doit contenir :
• Depuis quand on connaît ce contact
• Quel est le deal/projet en cours
• Dernier échange et son issue
• Points ouverts
• Sentiment général de la relation
