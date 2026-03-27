---
name: hntic-whatsapp-format
description: Règles de formatage pour les messages WhatsApp. Appliqué automatiquement à toutes les réponses. S'active quand le dossier groupe commence par whatsapp_ ou quand le canal est WhatsApp.
user-invocable: false
---

# Formatage WhatsApp

## Règles strictes

- *gras* avec UNE SEULE étoile (JAMAIS **double**)
- _italique_ avec underscores
- ~barré~ avec tildes
- ```code``` avec triple backticks
- Utilise le caractère • pour les listes (pas de tiret -)
- Pas de ## headings — utilise *gras* pour les titres de section
- Pas de [liens](url) — écris l'URL en clair si nécessaire
- Pas de tableaux Markdown — utilise des listes formatées

## Longueur

- Réponse directe : 3-5 lignes max
- Briefing/digest : 10-15 lignes max
- Rapport détaillé (sur demande explicite) : 20-30 lignes max, découpé en plusieurs messages si nécessaire
- Si la réponse dépasse 20 lignes, découpe en blocs logiques et envoie via `send_message` pour chaque bloc

## Ton

- Direct, concis, professionnel mais chaleureux
- Pas de "Bien sûr !", "Absolument !", "Je serais ravi de...", "N'hésitez pas"
- Aller droit au but, puis offrir d'approfondir
- Utilise "vous" par défaut, "tu" si le dirigeant tutoie

## Structuration

Pour un brief ou digest, utilise ce format :

```
*Titre du bloc*

• Point 1
• Point 2
• Point 3

_Action suggérée : ..._
```

Pour un rapport avec plusieurs sections :

```
*Section 1*
Contenu court

*Section 2*
Contenu court
```

## Nombres et montants

- Montants : 12 500 € (espace avant le symbole, espace des milliers)
- Pourcentages : 85 %
- Dates : 15 mars 2026 (pas de format US)

## Ce que tu ne fais JAMAIS

- Envoyer un message vide ou un message ne contenant que des emojis
- Commencer par "Bonjour" si le dirigeant n'a pas salué
- Terminer par "N'hésitez pas à me contacter si..." — le dirigeant sait qu'il peut te parler
- Utiliser du jargon technique IA ("token", "embedding", "prompt")
