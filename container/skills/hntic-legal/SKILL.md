---
name: hntic-legal
description: Module juridique du dirigeant. Se déclenche sur "contrat", "regarde ce contrat", "NDA", "obligations", "échéances légales", "est-ce que je suis en règle", "compliance", "risque juridique".
---

# Module juridique

Aide le dirigeant sur les questions juridiques courantes d'une PME.

## Revue de contrat

Quand le dirigeant envoie un contrat (PDF, image, ou texte copié) :

1. *Extraire le texte* si c'est un document (via Read ou Vision)
2. *Identifier le type* : client, fournisseur, emploi, bail, assurance, NDA, autre
3. *Analyser clause par clause* en se concentrant sur :

| Clause | Points de vigilance |
|--------|-------------------|
| Durée et renouvellement | Tacite reconduction ? Préavis ? Durée d'engagement ? |
| Résiliation | Conditions de sortie ? Pénalités ? |
| Responsabilité | Plafonnée ? Cas d'exclusion ? |
| Paiement | Délais ? Pénalités de retard ? |
| Propriété intellectuelle | Cession ? Licence ? Limites ? |
| Confidentialité | Durée ? Périmètre ? |
| Juridiction | Tribunaux compétents ? Droit applicable ? |
| Données personnelles | RGPD ? Sous-traitant ? DPA ? |

4. *Classer les risques* :
   - 🟢 Acceptable — clause standard
   - 🟡 À discuter — clause inhabituelle mais négociable
   - 🔴 Risqué — clause défavorable ou dangereuse

5. *Stocker* dans `contracts` et `documents`

### Format de sortie

```
*Analyse — {Type de contrat} — {Partie}*

*Résumé*
{2-3 phrases : objet, durée, montant, parties}

*Points d'attention*
🔴 {Clause risquée} — {explication et suggestion}
🟡 {Clause à discuter} — {explication}
🟢 Reste du contrat — clauses standards

*Recommandation*
{Signer / négocier tel point / faire relire par un avocat}

_Je ne suis pas avocat. Pour les contrats importants, consulte un professionnel._
```

## Suivi des obligations

```sql
-- Obligations à venir
SELECT * FROM obligations
WHERE status = 'pending' AND deleted_at IS NULL
ORDER BY due_date ASC LIMIT 20

-- Obligations en retard
SELECT * FROM obligations
WHERE status = 'overdue' AND deleted_at IS NULL
ORDER BY due_date ASC
```

### Format
```
*Obligations — Point de situation*

*En retard* ⚠
• {date} — {titre} ({catégorie})

*Cette semaine*
• {date} — {titre}

*Ce mois*
• {date} — {titre}
```

## Contrats expirant

```sql
SELECT c.*, co.name as company_name FROM contracts c
LEFT JOIN companies co ON c.company_id = co.id
WHERE c.status = 'active' AND c.end_date IS NOT NULL
  AND c.end_date <= date('now', '+60 days') AND c.deleted_at IS NULL
ORDER BY c.end_date ASC
```

## Disclaimer

Toujours ajouter en fin d'analyse juridique :
_Je ne suis pas avocat. Cette analyse est indicative. Pour tout engagement significatif, consulte un professionnel du droit._
