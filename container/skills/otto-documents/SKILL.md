---
name: otto-documents
description: Créer, lire et modifier des documents Office (Word, Excel, PowerPoint) avec OfficeCLI. Utilise ce skill quand le dirigeant demande de créer, modifier, analyser ou exporter un document .docx, .xlsx ou .pptx.
allowed-tools: Bash(officecli:*)
---

# Création de documents — OfficeCLI

Utilise `officecli` pour tous les documents Office. C'est un CLI qui crée des fichiers Word, Excel et PowerPoint sans dépendance.

## Règles Otto

1. Crée toujours dans `/tmp/` (espace temporaire)
2. Après création, montre le résumé au dirigeant
3. Demande : "Tu veux que je le sauvegarde dans tes documents ?"
4. Si oui → copie dans `/workspace/group/documents/` et indexe dans la table `documents` de business.db
5. Valide toujours avec `officecli validate` avant de montrer au dirigeant

## Commandes essentielles

```bash
# Créer un fichier vierge
officecli create /tmp/fichier.pptx

# Ajouter un slide avec fond gradient
officecli add /tmp/fichier.pptx / --type slide --prop background=0A0A0F-1A1A2E-180

# Ajouter un shape texte
officecli add /tmp/fichier.pptx '/slide[1]' --type shape \
  --prop text="Titre" --prop x=2cm --prop y=5cm --prop width=30cm --prop height=3cm \
  --prop font=Georgia --prop size=48 --prop bold=true --prop color=FFFFFF --prop align=center --prop fill=none

# Ajouter un chart
officecli add /tmp/fichier.pptx '/slide[1]' --type chart \
  --prop chartType=bar --prop categories="Q1,Q2,Q3,Q4" --prop series1="CA:100,150,200,250" \
  --prop x=2cm --prop y=5cm --prop width=20cm --prop height=12cm --prop colors=4ade80,60a5fa

# Ajouter un tableau
officecli add /tmp/fichier.pptx '/slide[1]' --type table \
  --prop rows=3 --prop cols=2 --prop r1c1="Nom" --prop r1c2="Valeur" \
  --prop headerRow=true --prop style=medium1

# Valider
officecli validate /tmp/fichier.pptx

# Voir la structure
officecli view /tmp/fichier.pptx outline
```

## Mode batch (RECOMMANDÉ pour les slides complexes)

Construire un slide entier en une commande avec un heredoc JSON :

```bash
cat <<'EOF' | officecli batch /tmp/fichier.pptx
[
  {"command":"add","parent":"/","type":"slide","props":{"layout":"blank","background":"0A0A0F-1A1A2E-180"}},
  {"command":"add","parent":"/slide[1]","type":"shape","props":{"text":"Titre","x":"2cm","y":"5cm","width":"30cm","height":"3cm","font":"Georgia","size":"48","bold":"true","color":"FFFFFF","align":"center","fill":"none"}},
  {"command":"add","parent":"/slide[1]","type":"shape","props":{"text":"Sous-titre","x":"2cm","y":"9cm","width":"30cm","height":"2cm","font":"Calibri","size":"22","color":"888888","align":"center","fill":"none"}},
  {"command":"set","path":"/slide[1]","props":{"transition":"fade"}}
]
EOF
```

## Patterns de slides

### Couverture (fond sombre gradient)
```json
{"command":"add","parent":"/","type":"slide","props":{"layout":"blank","background":"0A0A0F-1A1A2E-180"}}
```
- Titre : Georgia 48-64pt, blanc, centré, y=5cm
- Sous-titre : Calibri 22-28pt, gris (#888888), centré, y=9-10cm
- Transition : fade

### Stats (fond blanc, 3 colonnes)
3 blocs côte à côte pour les KPIs :
- Positions x : 2cm, 12.5cm, 23cm (largeur 9cm chacun)
- Valeur : Georgia 44-64pt, couleur accent, y=5cm
- Label : Calibri 13-14pt, gris, y=9.5cm

### Contenu texte (fond sombre)
- Titre : Georgia 36pt, blanc, y=1cm
- Blocs : 2 colonnes (x=2cm et x=18cm, largeur 14cm)
- Sous-titres blocs : Georgia 24-28pt, couleur accent
- Texte : Calibri 14-16pt, gris clair (#CCCCCC)

### Tableau (fond blanc)
- Titre : Georgia 36pt, noir (#0A0A0F), y=1cm
- Table : style=medium1, headerRow=true, bandedRows=true
- Position : x=4cm, y=5cm, largeur 26cm

### Closing (gradient = même que couverture)
- Logo/Nom : Georgia 64pt, blanc, centré
- Tagline : Calibri 22pt, gris, italique
- Contact : Calibri 14pt, couleur accent

## Palette recommandée

| Variable | Hex | Usage |
|----------|-----|-------|
| Fond sombre | 0A0A0F | Slides impactantes |
| Fond gradient | 0A0A0F-1A1A2E-180 | Couverture, closing |
| Blanc | FFFFFF | Fond classique |
| Gris texte | 888888 | Sous-titres, labels |
| Gris clair | CCCCCC | Corps texte sur fond sombre |
| Vert accent | 4ade80 | Données positives |
| Bleu accent | 60a5fa | Données neutres |
| Rouge accent | FF6B6B | Données négatives |
| Jaune accent | facc15 | Highlights |

## Transitions

| Transition | Usage |
|-----------|-------|
| fade | Couverture, closing |
| push-left | Slides de contenu (progression) |

## Word (.docx)

```bash
officecli create /tmp/rapport.docx
officecli add /tmp/rapport.docx /body --type paragraph --prop text="Titre" --prop style=Heading1
officecli add /tmp/rapport.docx /body --type paragraph --prop text="Contenu du paragraphe."
officecli add /tmp/rapport.docx /body --type table --prop rows=3 --prop cols=3 --prop r1c1="Col A" --prop r1c2="Col B" --prop r1c3="Col C"
```

## Excel (.xlsx)

```bash
officecli create /tmp/data.xlsx
officecli set /tmp/data.xlsx '/Sheet1/A1' --prop value="Nom" --prop bold=true
officecli set /tmp/data.xlsx '/Sheet1/B1' --prop value="CA" --prop bold=true
officecli set /tmp/data.xlsx '/Sheet1/A2' --prop value="Client A"
officecli set /tmp/data.xlsx '/Sheet1/B2' --prop value=50000
officecli add /tmp/data.xlsx '/Sheet1' --type chart --prop chartType=bar --prop range="A1:B5"
```

## Lire un document existant

```bash
# Structure
officecli view /tmp/fichier.pptx outline

# Texte brut
officecli view /tmp/rapport.docx text

# Problèmes détectés
officecli view /tmp/fichier.pptx issues

# Élément spécifique en JSON
officecli get /tmp/fichier.pptx '/slide[1]/shape[2]' --json
```

## Modifier un document existant

```bash
# Modifier le texte d'un shape
officecli set /tmp/fichier.pptx '/slide[1]/shape[2]' --prop text="Nouveau texte"

# Modifier le style
officecli set /tmp/rapport.docx '/body/p[3]/r[1]' --prop bold=true --prop color=FF0000

# Supprimer un élément
officecli remove /tmp/fichier.pptx '/slide[3]'

# Déplacer un slide
officecli move /tmp/fichier.pptx '/slide[3]' --to / --index 1
```

## Aide intégrée

Quand tu ne connais pas une propriété, demande à OfficeCLI au lieu de deviner :

```bash
officecli pptx set              # Tous les éléments modifiables
officecli pptx set shape        # Propriétés d'un shape
officecli pptx set shape.fill   # Détail d'une propriété
officecli pptx add              # Tous les types ajoutables
officecli docx add              # Idem pour Word
officecli xlsx set              # Idem pour Excel
```

## Erreurs courantes

| Erreur | Solution |
|--------|----------|
| `--name "foo"` | Utilise `--prop name="foo"` |
| Coordonnées négatives | Pas supporté, utilise x=0cm |
| `/shape[monnom]` | Index numérique uniquement : `/shape[3]` |
| Devinette de propriétés | Lance `officecli pptx set shape` pour voir les noms exacts |
| `\n` dans les textes shell | Utilise `\\n` dans --prop |
| Style table invalide | Valeurs : medium1, medium2, light1, dark1, none |
