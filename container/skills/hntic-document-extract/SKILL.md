---
name: hntic-document-extract
description: Extrait le contenu des documents, images et vocaux reçus via WhatsApp. Stocke dans la business.db et classifie automatiquement. S'active quand le message contient "[Document reçu", "[Image reçue", "[Vocal reçu", ou quand un fichier est mentionné dans /workspace/group/documents/.
---

# Extraction de documents et media

Quand un document, une image ou un vocal est reçu via WhatsApp, extrais son contenu et alimente les tables business. Cette extraction est SYSTÉMATIQUE pour tout document reçu.

## Flow d'extraction

### 1. Identifier le type de media

Le message contient un indicateur du type :
- `[Document reçu : facture.pdf]` → PDF
- `[Document reçu : rapport.docx]` → Word
- `[Document reçu : presentation.pptx]` → PowerPoint
- `[Document reçu : budget.xlsx]` → Excel
- `[Image reçue : photo_123.jpg]` → Image
- `[Vocal reçu : audio_123.ogg]` → Audio

### 2. Extraire le contenu selon le type

#### PDF

```bash
pdftotext /workspace/group/documents/{filename} -
```

Si `pdftotext` échoue (PDF scanné sans couche texte), utiliser le tool Read du SDK qui supporte la vision pour lire le PDF comme une image.

#### Word (.docx)

```bash
pandoc /workspace/group/documents/{filename} -t plain
```

Ou en Python si pandoc échoue :
```python
python3 -c "
from docx import Document
doc = Document('/workspace/group/documents/{filename}')
for p in doc.paragraphs:
    print(p.text)
for t in doc.tables:
    for row in t.rows:
        print(' | '.join(c.text for c in row.cells))
"
```

#### PowerPoint (.pptx)

```python
python3 -c "
from pptx import Presentation
prs = Presentation('/workspace/group/documents/{filename}')
for i, slide in enumerate(prs.slides, 1):
    print(f'--- Slide {i} ---')
    for shape in slide.shapes:
        if shape.has_text_frame:
            for p in shape.text_frame.paragraphs:
                if p.text.strip():
                    print(p.text)
        if shape.has_table:
            for row in shape.table.rows:
                print(' | '.join(c.text for c in row.cells))
"
```

#### Excel (.xlsx)

```python
python3 -c "
import openpyxl
wb = openpyxl.load_workbook('/workspace/group/documents/{filename}', data_only=True)
for sheet in wb.sheetnames:
    ws = wb[sheet]
    print(f'--- {sheet} ---')
    for row in ws.iter_rows(max_row=50, values_only=True):
        vals = [str(c) if c is not None else '' for c in row]
        if any(vals):
            print(' | '.join(vals))
"
```

#### Images (.jpg, .png, .jpeg, .webp)

Utiliser le tool Read du SDK pour voir l'image. Claude Vision est natif.

Types d'images courants et ce qu'il faut extraire :
• *Carte de visite* → nom, entreprise, poste, téléphone, email
• *Capture d'écran* → texte visible, contexte
• *Photo de document/facture/devis* → contenu textuel, montants, dates, parties
• *Photo de reçu/ticket* → montant, fournisseur, date
• *Photo quelconque* → description brève + contexte si business

Pour les photos de documents (factures, contrats, cartes de visite), extraire TOUTES les informations textuelles visibles.

#### Vocaux (audio)

Les vocaux sont transcrits automatiquement par le host avant d'arriver à l'agent. Le contenu transcrit est dans le message. Si la transcription n'est pas disponible :

```bash
curl -s -X POST "https://api.openai.com/v1/audio/transcriptions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F file="@/workspace/group/documents/{filename}" \
  -F model="whisper-1" \
  -F language="fr"
```

## 3. Stocker le document

TOUJOURS indexer dans la table `documents` avec le contenu extrait dans `extracted_text` :

```sql
INSERT INTO documents (title, category, file_path, file_type, extracted_text,
  source_chat_jid, source_message_id, related_contact_id, related_company_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```

Catégories possibles :
• `invoice` — facture (y compris photo de facture)
• `contract` — contrat
• `proposal` — devis/proposition
• `report` — rapport
• `id_card` — carte d'identité, carte de visite
• `receipt` — reçu, ticket (y compris photo de ticket)
• `cv` — CV, profil candidat
• `presentation` — présentation, deck
• `spreadsheet` — tableur, budget, reporting
• `other` — autre

## 4. Classer et alimenter les tables business

Après extraction, alimenter les tables appropriées :

| Contenu détecté | Action |
|-----------------|--------|
| Facture avec montant + fournisseur | Créer/MAJ dans `invoices` |
| Devis avec montant + prestation | Créer/MAJ dans `deals` ou `expenses` |
| Contrat avec parties + conditions | Créer dans `contracts` + `contract_clauses` |
| Carte de visite (photo ou document) | Créer dans `contacts` + `companies` |
| CV | Créer dans `candidates` |
| Document RH (contrat travail, fiche de paie) | MAJ dans `team_members` |
| Obligation (courrier admin, relance URSSAF) | Créer dans `obligations` |
| Reçu/ticket | Créer dans `expenses` |

## 5. Confirmer au dirigeant

Après extraction et classification, confirmer brièvement :

```
Document reçu et traité :
• *Type* : {catégorie}
• *Résumé* : {2-3 phrases du contenu}
• *Stocké dans* : {table(s) alimentée(s)}
{Si action requise : "Action : {action suggérée}"}
```

## Règles de prudence

• Si le document est flou ou illisible, demander confirmation : "Le document est difficile à lire. J'ai cru voir {info}. C'est correct ?"
• Si le montant est ambigu (HT vs TTC), stocker le montant le plus explicite et noter l'ambiguïté
• Pour les contrats, toujours noter les dates clés (début, fin, renouvellement, préavis)
• Ne JAMAIS stocker des données bancaires (RIB, numéros de carte) dans les champs texte — les mentionner comme "RIB fourni" sans le reproduire
• Les pièces d'identité : ne stocker que le nom et la date de validité, pas le numéro
• Pour les photos floues : tenter quand même la lecture, signaler l'incertitude au dirigeant
