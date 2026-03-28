/**
 * Memory Consolidator (HNTIC)
 *
 * Extracts learnings from recent conversations and consolidates
 * the memory system (CLAUDE.md hot cache + memory/ files).
 *
 * Two modes:
 * - Daily: extract learnings from today's conversations (lightweight, Haiku)
 * - Weekly (AutoDream): full consolidation — deduplicate, prune stale entries,
 *   update CLAUDE.md hot cache, refresh relationship summaries
 */

import { ASSISTANT_NAME, GROUPS_DIR } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { RegisteredGroup } from './types.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

interface ConsolidatorDependencies {
  mainGroup: RegisteredGroup;
  mainChatJid: string;
  queue: GroupQueue;
}

const DAILY_PROMPT = `[SCHEDULED TASK - EXTRACTION MÉMOIRE]

Tu es en mode extraction de mémoire. Analyse les conversations récentes (dernières 24h) stockées dans conversations/ et les interactions récentes dans business.db.

Applique le skill hntic-session-learnings :
1. Identifie les nouvelles infos apprises (corrections, préférences, contacts, acronymes, décisions)
2. Stocke-les dans les bons fichiers memory/ ou dans business.db
3. Si le CLAUDE.md doit être mis à jour (nouveau contact fréquent, acronyme), fais-le
4. Garde le CLAUDE.md sous 80 lignes

Ne réponds PAS au dirigeant — travaille silencieusement.`;

const WEEKLY_PROMPT = `[SCHEDULED TASK - AUTODREAM CONSOLIDATION HEBDOMADAIRE]

Tu es en mode AutoDream. Consolide toute la mémoire de la semaine.

Étapes :
1. Relis toutes les entrées dans memory/ (glossary.md, people/, projects/, context/)
2. Déduplique — fusionne les entrées qui disent la même chose
3. Corrige les contradictions — si une mémoire ancienne contredit une récente, garde la récente
4. Convertis les dates relatives en dates absolues ("hier" → la vraie date)
5. Supprime les mémoires obsolètes (deals won/lost, projets terminés)
6. Mets à jour le CLAUDE.md :
   - Ajoute les nouveaux contacts fréquents (apparus 3+ fois cette semaine)
   - Retire les contacts qui n'apparaissent plus depuis 30 jours
   - Mets à jour les projets actifs
   - Garde le fichier sous 80 lignes
7. Mets à jour les relationship_summaries dans business.db pour les contacts avec des interactions récentes

Utilise query_business_db et mutate_business_db pour accéder aux données.
Ne réponds PAS au dirigeant — travaille silencieusement.

Résume ce que tu as fait en une ligne pour les logs.`;

/**
 * Run daily learning extraction (quick, Haiku).
 */
export async function runDailyLearnings(
  deps: ConsolidatorDependencies,
): Promise<void> {
  logger.info('Starting daily memory extraction');

  try {
    await runContainerAgent(
      deps.mainGroup,
      {
        prompt: DAILY_PROMPT,
        groupFolder: deps.mainGroup.folder,
        chatJid: deps.mainChatJid,
        isMain: true,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        model: 'haiku',
        maxTurns: 10,
        maxBudgetUsd: 0.10,
      },
      (proc, containerName) =>
        deps.queue.registerProcess(
          deps.mainChatJid,
          proc,
          containerName,
          deps.mainGroup.folder,
        ),
    );

    logger.info('Daily memory extraction complete');
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Daily memory extraction failed',
    );
  }
}

/**
 * Run weekly AutoDream consolidation (thorough, Haiku).
 */
export async function runWeeklyAutoDream(
  deps: ConsolidatorDependencies,
): Promise<void> {
  logger.info('Starting weekly AutoDream consolidation');

  try {
    await runContainerAgent(
      deps.mainGroup,
      {
        prompt: WEEKLY_PROMPT,
        groupFolder: deps.mainGroup.folder,
        chatJid: deps.mainChatJid,
        isMain: true,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        model: 'haiku',
        maxTurns: 20,
        maxBudgetUsd: 0.25,
      },
      (proc, containerName) =>
        deps.queue.registerProcess(
          deps.mainChatJid,
          proc,
          containerName,
          deps.mainGroup.folder,
        ),
    );

    logger.info('Weekly AutoDream consolidation complete');
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Weekly AutoDream consolidation failed',
    );
  }
}
