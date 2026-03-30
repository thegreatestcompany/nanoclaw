# Human-in-the-Loop Pattern — Pending File State Machine

## Problème

Le modèle IA peut contourner les instructions de confirmation basées sur le prompt (il met `user_confirmed: true` sans demander). Les garde-fous prompt-based ne sont pas fiables pour les opérations sensibles.

## Solution

Un mécanisme de confirmation **côté code** basé sur des fichiers "pending" dans le filesystem du container. L'opération sensible est bloquée au premier appel, autorisée au second (après que l'agent a montré l'opération à l'utilisateur).

## Comment ça marche

```
1. Agent appelle un outil sensible (send_email, DELETE, etc.)
        ↓
2. PreToolUse hook intercepte :
   - Vérifie s'il existe un fichier pending pour ce type d'opération
   - NON → BLOQUE, sauvegarde l'opération dans .pending_{type}/{id}.json
   - OUI → AUTORISE, supprime le fichier pending
        ↓
3. Si bloqué : le hook retourne un message demandant à l'agent de montrer
   l'opération au dirigeant via WhatsApp (send_message) et demander confirmation
        ↓
4. L'agent envoie le résumé sur WhatsApp : "Je vais [action]. Tu confirmes ?"
        ↓
5. Le dirigeant répond naturellement : "oui", "go", "ok", "non", "modifie X"
        ↓
6. Le message arrive en IPC → nouvelle query → l'agent voit la confirmation
        ↓
7. L'agent rappelle le même outil avec les mêmes paramètres
        ↓
8. PreToolUse : pending file existe → AUTORISE → opération exécutée
        ↓
9. Fichier pending supprimé
```

## Pourquoi c'est fiable

- **Pas contournable par le modèle** : le hook est du code, pas un prompt
- **État dans le filesystem** : le fichier pending sert de preuve que l'agent a montré l'opération à l'utilisateur
- **Pas besoin de session resume** : le fichier pending persiste dans `/workspace/group/` (monté depuis le host)
- **Conversation naturelle** : l'utilisateur répond en langage naturel, pas par oui/non

## Opérations protégées

### Email (send_email)

| Fichier | `/workspace/group/.pending_emails/{id}.json` |
|---------|-----------------------------------------------|
| Contenu | `{ to, subject, body, created }` |
| Hook | `mcp__gmail__send_email` dans PreToolUse |
| Code | `container/agent-runner/src/index.ts` |

### Mutations DB sensibles (mutate_business_db)

| Fichier | `/workspace/group/.pending_mutations/{id}.json` |
|---------|--------------------------------------------------|
| Contenu | `{ sql, table, created }` |
| Hook | `mcp__business-db__mutate_business_db` dans PreToolUse |
| Opérations | DELETE, modifications financières, changement de stage deal, UPDATE sans WHERE |

## Ajouter une nouvelle opération protégée

Pour protéger un nouvel outil avec ce pattern :

1. Dans `container/agent-runner/src/index.ts`, dans `createPreToolUseHook()` :

```typescript
if (hookInput.tool_name === 'mcp__xxx__dangerous_tool') {
  const pendingDir = '/workspace/group/.pending_xxx';
  const pendingFiles = fs.existsSync(pendingDir)
    ? fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'))
    : [];

  if (pendingFiles.length > 0) {
    // Pending exists → user confirmed → ALLOW
    const pendingFile = path.join(pendingDir, pendingFiles[0]);
    try { fs.unlinkSync(pendingFile); } catch {}
    // Fall through — allow
  } else {
    // No pending → save and BLOCK
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(
      path.join(pendingDir, `pending-${Date.now()}.json`),
      JSON.stringify({ /* operation details */ }),
    );
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Opération en attente. Montre le résumé au dirigeant et demande confirmation.`,
      },
    };
  }
}
```

2. Le CLAUDE.md n'a pas besoin de changement — le hook gère tout automatiquement.

## Limites

- **Un seul pending à la fois** : si l'agent tente deux opérations sensibles d'affilée, la deuxième sera autorisée sans confirmation (le pending de la première suffit). Acceptable pour l'usage courant.
- **Pending persiste** : si le container meurt après avoir créé un pending mais avant la confirmation, le pending reste. Le prochain appel sera auto-autorisé. Risque faible (le container vit 30 min max).
- **Pas de matching** : le hook vérifie juste l'existence d'un fichier pending, pas que les paramètres correspondent. L'agent pourrait changer les paramètres entre les deux appels. Acceptable car l'agent est sous contrôle du même utilisateur.

## Comparaison avec l'approche prompt-based

| | Prompt-based (`user_confirmed`) | Pending file |
|---|---|---|
| Contournable par le modèle | ✅ Oui (met `true` sans demander) | ❌ Non (code-level) |
| Complexité du prompt | Élevée (instructions longues) | Aucune |
| Tokens consommés | ~200 tokens pour les instructions | 0 |
| Conversation naturelle | ❌ Oui/Non rigide | ✅ Langage naturel |
| Fiabilité | ~60% | ~99% |
