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

# 4. Aggregate + rebuild dashboard.
echo "--- aggregating metrics" | tee -a "$LOG"
node aggregate.js | tee -a "$LOG"

echo "--- rebuilding index.html from template.html" | tee -a "$LOG"
node -e "
const fs = require('fs');
fs.writeFileSync('index.html',
  fs.readFileSync('template.html', 'utf8').replace('__METRICS__', fs.readFileSync('data/metrics.json', 'utf8'))
);
console.log('index.html rebuilt (' + fs.statSync('index.html').size + ' bytes)');
" | tee -a "$LOG"

echo "==== $(date -u +%FT%TZ)  refresh complete" | tee -a "$LOG"
