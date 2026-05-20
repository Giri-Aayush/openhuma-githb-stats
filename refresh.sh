#!/usr/bin/env bash
# Full weekly refresh: snapshot ephemeral state + refetch historical data + rebuild dashboard.
# Safe to run any time; idempotent on historical data, append-only on snapshots.

set -euo pipefail
cd "$(dirname "$0")"

REPO="tinyhumansai/openhuman"
LOG="data/refresh.log"

echo "==== $(date -u +%FT%TZ)  refresh started" | tee -a "$LOG"

# 1. Ephemeral snapshot (traffic + headline counts). Always run first so we
#    capture the moment-in-time state before any other API calls might race.
node snapshot.js | tee -a "$LOG"

# 2. Refetch historical data (these endpoints preserve history, but new
#    rows accumulate, so we re-pull the full lists each run).
echo "--- refetching PRs"          | tee -a "$LOG"
gh api -X GET "repos/$REPO/pulls?state=all&per_page=100" --paginate > data/prs.json
echo "--- refetching stargazers"   | tee -a "$LOG"
gh api -H "Accept: application/vnd.github.v3.star+json" \
       -X GET "repos/$REPO/stargazers?per_page=100" --paginate > data/stars.json
echo "--- refetching commits"      | tee -a "$LOG"
gh api -X GET "repos/$REPO/commits?per_page=100" --paginate > data/commits.json
echo "--- refetching forks"        | tee -a "$LOG"
gh api -X GET "repos/$REPO/forks?per_page=100&sort=newest" --paginate > data/forks.json
echo "--- refetching issues+PRs"   | tee -a "$LOG"
gh api -X GET "repos/$REPO/issues?state=all&per_page=100" --paginate > data/issues.json

# 3. Stargazer profile enrichment (GraphQL, ~30s for 10K stargazers).
echo "--- refreshing stargazer profiles (GraphQL)" | tee -a "$LOG"
node fetch_stargazer_profiles.js | tail -3 | tee -a "$LOG"

# 4. Competitor refresh: headlines (cheap) + incremental star fetch (skipped if no JSONL).
echo "--- refreshing competitor headlines" | tee -a "$LOG"
mkdir -p data/competitors
{
  gh api repos/openclaw/openclaw 2>/dev/null              | jq '{full_name, stargazers_count, forks_count, subscribers_count, open_issues_count, created_at, pushed_at, description}'
  gh api repos/NousResearch/hermes-agent 2>/dev/null      | jq '{full_name, stargazers_count, forks_count, subscribers_count, open_issues_count, created_at, pushed_at, description}'
  gh api repos/tinyhumansai/openhuman 2>/dev/null         | jq '{full_name, stargazers_count, forks_count, subscribers_count, open_issues_count, created_at, pushed_at, description}'
} | node -e "
const chunks = require('fs').readFileSync(0, 'utf8').split(/\n(?=\{)/).filter(s => s.trim());
require('fs').writeFileSync('data/competitors/headlines.json', JSON.stringify(chunks.map(JSON.parse), null, 2));
"

echo "--- incremental competitor star refresh" | tee -a "$LOG"
node fetch_competitor_stars_incremental.js openclaw openclaw       | tee -a "$LOG" || echo "openclaw incremental skipped"
node fetch_competitor_stars_incremental.js NousResearch hermes-agent | tee -a "$LOG" || echo "hermes incremental skipped"
node fetch_competitor_stars_incremental.js tinyhumansai openhuman    | tee -a "$LOG" || echo "openhuman incremental skipped"

# 5. Aggregate + rebuild both pages.
echo "--- aggregating metrics" | tee -a "$LOG"
node aggregate.js | tee -a "$LOG"
echo "--- aggregating competitor comparison" | tee -a "$LOG"
node aggregate_competitors.js | tee -a "$LOG"

echo "--- rebuilding index.html + compare.html" | tee -a "$LOG"
node -e "
const fs = require('fs');
fs.writeFileSync('index.html',
  fs.readFileSync('template.html', 'utf8').replace('__METRICS__', fs.readFileSync('data/metrics.json', 'utf8'))
);
fs.writeFileSync('compare.html',
  fs.readFileSync('compare_template.html', 'utf8').replace('__COMPETITOR_METRICS__', fs.readFileSync('data/competitors/metrics.json', 'utf8'))
);
console.log('rebuilt index.html (' + fs.statSync('index.html').size + 'b) + compare.html (' + fs.statSync('compare.html').size + 'b)');
" | tee -a "$LOG"

echo "==== $(date -u +%FT%TZ)  refresh complete" | tee -a "$LOG"
