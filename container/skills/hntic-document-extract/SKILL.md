---
name: hntic-document-extract
description: Extrait le contenu des documents, images et vocaux reçus via WhatsApp. Stocke dans la business.db et classifie automatiquement. S'active quand le message contient "[Document reçu", "[Image reçue", "[Vocal reçu", ou quand un fichier est mentionné dans /workspace/group/documents/.
---

# Extraction de documents et media

Quand un document, une image ou un vocal est reçu via WhatsApp, extrais son contenu et alimente les tables business.

## Flow d'extraction

### 1. Identifier le type de media

Le message contient un indicateur du type :
- `[Document reçu : facture.pdf]` → PDF
- `[Image reçue : photo_123.jpg]` → Image
- `[Vocal reçu : audio_123.ogg]` → Audio

### 2. Extraire le contenu selon le type

#### PDF

```bash
pdftotext /workspace/group/documents/{filename} -
```

Si `pdftotext` échoue (PDF scanné sans couche texte), utiliser le tool Read du SDK qui supporte la vision pour lire le PDF comme une image.

#### Images

Utiliser le tool Read du SDK pour voir l'image. Claude Vision est natif.

Types d'images courants et ce qu'il faut extraire :
• *Carte de visite* → nom, entreprise, poste, téléphone, email
• *Capture d'écran* → texte visible, contexte
• *Photo de document* → contenu textuel
• *Facture/devis scanné* → montant, fournisseur, date, références
• *Photo quelconque* → description brève + contexte si business

#### Vocaux (audio)

Les vocaux nécessitent une transcription. Si Whisper est disponible :

```bash
curl -s -X POST "https://api.openai.com/v1/audio/transcriptions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file="@/workspace/group/documents/{filename}" \
  -F model="whisper-1" \
  -F language="fr"
```

Si Whisper n'est pas configuré, informer le dirigeant :
"J'ai reçu un vocal mais la transcription n'est pas encore configurée. Tu peux me résumer ce qu'il contient ?"

## 3. Stocker le document

```sql
INSERT INTO documents (title, category, file_path, file_type, extracted_text,
  source_chat_jid, source_message_id, related_contact_id, related_company_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```

Catégories possibles :
• `invoice` — facture
• `contract` — contrat
• `proposal` — devis/proposition
• `report` — rapport
• `id_card` — carte d'identité, carte de visite
• `receipt` — reçu, ticket
• `other` — autre

## 4. Classer et alimenter les tables business

Après extraction, appliquer la logique du skill hntic-classify :

| Contenu détecté | Action |
|-----------------|--------|
| Facture avec montant + fournisseur | Créer/MAJ dans `invoices` |
| Devis avec montant + prestation | Créer/MAJ dans `deals` ou `expenses` |
| Contrat avec parties + conditions | Créer dans `contracts` |
| Carte de visite | Créer dans `contacts` + `companies` |
| Document RH (contrat travail, fiche de paie) | MAJ dans `team_members` |
| Obligation (courrier admin, relance URSSAF) | Créer dans `obligations` |

## 5. Confirmer au dirigeant

Après extraction et classification, confirmer brièvement :

```
Document reçu et traité :
• *Type* : {catégorie}
• *Résumé* : {2-3 phrases}
• *Stocké dans* : {table(s) alimentée(s)}
{Si action requise : "Action : {action suggérée}"}
```

## Règles de prudence

• Si le document est flou ou illisible, demander confirmation : "Le document est difficile à lire. J'ai cru voir {info}. C'est correct ?"
• Si le montant est ambigu (HT vs TTC), stocker le montant le plus explicite et noter l'ambiguïté
• Pour les contrats, toujours ajouter le disclaimer juridique
• Ne JAMAIS stocker des données bancaires (RIB, numéros de carte) dans les champs texte — les mentionner comme "RIB fourni" sans le reproduire
• Les pièces d'identité : ne stocker que le nom et la date de validité, pas le numéro
