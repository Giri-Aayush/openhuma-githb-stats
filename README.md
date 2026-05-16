# openhuman growth dashboard

Static dashboard tracking [tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman) GitHub growth — PRs, stars, forks, contributors, fork quality, momentum, and a premium-pipeline view of notable stargazers.

Deployed via Netlify. Source-of-truth is `index.html` (built from `template.html` + `data/metrics.json`).

## Refresh the dashboard

```bash
./refresh.sh            # full pipeline — re-fetch, re-aggregate, rebuild index.html
git add index.html data/metrics.json data/snapshots.jsonl
git commit -m "refresh: $(date -u +%F)"
git push                # Netlify auto-deploys
```

The full refresh takes ~1 min (mostly GraphQL pagination for stargazer profiles).

## Just snapshot ephemeral state

```bash
node snapshot.js        # append-only to data/snapshots.jsonl
```

GitHub only returns the **last 14 days** of traffic data. Run this at least weekly so we accumulate a real time series.

## Recommended cron (macOS)

```cron
# Daily ephemeral snapshot (cheap)
0 9 * * * cd /Users/aayushgiri/work/openhuman-github-stats && /opt/homebrew/bin/node snapshot.js >> data/snapshots.log 2>&1

# Weekly full refresh + push (rebuilds + deploys)
0 10 * * 1 cd /Users/aayushgiri/work/openhuman-github-stats && /opt/homebrew/bin/bash refresh.sh && /usr/bin/git -C . add -A && /usr/bin/git -C . commit -m "weekly refresh" && /usr/bin/git -C . push
```

## Layout

| File | Purpose |
|---|---|
| `template.html` | Dashboard HTML with `__METRICS__` placeholder |
| `aggregate.js` | Weekly + daily + cumulative aggregation, fork quality, momentum, pipeline |
| `fetch_stargazer_profiles.js` | GraphQL enrichment for `company` / `location` / `bio` |
| `snapshot.js` | Ephemeral capture → `data/snapshots.jsonl` |
| `refresh.sh` | Full pipeline |
| `index.html` | Built dashboard (Netlify serves at `/`) |

## Notes

- `gh` CLI must be authenticated.
- Traffic endpoints (clones / views / referrers / paths) require **Write** access on `tinyhumansai/openhuman`. Without it, `snapshot.js` records a 403 and continues.
- Founders are hard-coded in `aggregate.js` (`FOUNDERS` constant).
