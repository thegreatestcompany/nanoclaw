# Incident 2026-04-08 — Croissance disque anormale via containerd

**Date détection** : 2026-04-08
**Résolu** : 2026-04-09
**Sévérité** : Moyenne (pas critique mais trajectoire problématique)

## Symptôme

Croissance disque de **+5 Go en 24h** observée lors du check quotidien :

| Date | Disque utilisé | Delta |
|---|---|---|
| 2026-04-07 | 41 Go (19%) | — |
| 2026-04-08 | 46 Go (22%) | +5 Go ⚠️ |
| 2026-04-09 | 46 Go (22%) | 0 Go (stable) |

À ce rythme le disque de 226 Go aurait été saturé en ~6 semaines.

## Cause racine

Contrairement à l'hypothèse initiale (containers orphelins ou couches overlay sans cleanup), l'investigation a montré que les containers sont déjà spawned avec `--rm` dans `src/container-runner.ts` et qu'il n'y avait aucun container stoppé.

Le vrai coupable : **accumulation de Build Cache et d'images orphelines**.

`docker system df` au moment du diagnostic (2026-04-09) :

```
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          2         0         33.11GB   27.89GB (84%)
Containers      0         0         0B        0B
Local Volumes   0         0         0B        0B
Build Cache     582       0         39.18GB   39.18GB (100%)
```

À chaque exécution de `./container/build.sh`, BuildKit crée de nouvelles couches de cache. Si le Dockerfile ou le contexte de build change, les anciennes couches deviennent "dangling" mais ne sont pas automatiquement supprimées. En multipliant les rebuilds pendant la semaine de dev intensive, on a accumulé 582 entries de build cache pour ~39 Go, plus 28 Go de layers d'images orphelines (2 images, seulement 1 active).

Le pic de +5 Go le 7 → 8 avril correspond à une session de rebuild du container (nouvelle version pushée, changement de Dockerfile ou de skills).

## Remédiation

### Immédiat (2026-04-09)

```bash
docker builder prune -af     # libère 39.18 GB
docker image prune -af       # libère 1.48 GB
```

Résultat : **46 Go → 5.8 Go** (40 Go libérés, image `nanoclaw-agent:latest` rebuildée immédiatement après).

### Fix durable (source)

`container/build.sh` — prune automatique après chaque build :

```bash
${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# Prune dangling build cache layers superseded by this build.
${CONTAINER_RUNTIME} builder prune -f --filter "until=24h" >/dev/null 2>&1 || true
${CONTAINER_RUNTIME} image prune -f >/dev/null 2>&1 || true
```

Le filtre `until=24h` garde les couches utilisées dans les dernières 24h (cache incrémental actif) et ne prune que les vraiment orphelines.

### Fix durable (safety net)

Cron daily à `/etc/cron.daily/docker-prune` :

```bash
#!/bin/bash
# Runs via run-parts /etc/cron.daily (early morning, after backups)
/usr/bin/docker builder prune -f --filter 'until=168h'
/usr/bin/docker image prune -f
/usr/bin/docker container prune -f
```

Avec rotation du log à 500 lignes pour éviter la saturation.

## Métriques à suivre

- `df -h /` → doit rester sous 60% avec 1 client. Croissance attendue : <1 Go/semaine en usage normal
- `docker system df` → Build Cache doit rester sous 5 Go, Images sous 5 Go avec 1 image active
- `/var/log/docker-prune.log` → tracking des pruning quotidiens

## Ce qu'on a appris

- **Les containers `--rm` ne libèrent pas le build cache** — ils libèrent seulement leurs propres couches runtime. BuildKit cache vit séparément
- **Le diagnostic doit inclure `docker system df`** en premier, pas juste `du -sh /var/lib/containerd/` qui ne distingue pas images / cache / overlays
- **L'intensité de dev influe directement sur la taille du disque** — pendant une session avec 10+ rebuilds, on accumule rapidement plusieurs Go de cache
- **Les hypothèses peuvent être trompeuses** — la note initiale soupçonnait des couches overlay orphelines de containers runtime, alors que le vrai problème était le cache BuildKit

## Fichiers modifiés

- `container/build.sh` — ajout prune après build
- `/etc/cron.daily/docker-prune` (VPS) — safety net daily
- `docs/incident-2026-04-08-disk-growth.md` (ce fichier)
