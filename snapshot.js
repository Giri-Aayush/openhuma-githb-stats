// Captures ephemeral GitHub state (traffic + headline counts) into an
// append-only history file. GitHub only returns the last 14 days of traffic
// data, so this needs to run at least weekly to build a complete time series.
//
// Output: data/snapshots.jsonl (one JSON object per line)
// Traffic endpoints require push/maintain/admin access on the repo. They are
// captured opportunistically: a 403 is recorded with `traffic_error` and the
// rest of the snapshot proceeds normally.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'tinyhumansai/openhuman';
const OUT  = path.join(__dirname, 'data', 'snapshots.jsonl');

function ghJson(endpoint) {
  const r = spawnSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.status !== 0) {
    let body = null; try { body = JSON.parse(r.stdout || r.stderr); } catch {}
    return { ok: false, status: body?.status || 'error', message: body?.message || r.stderr?.trim() };
  }
  try { return { ok: true, data: JSON.parse(r.stdout) }; }
  catch (e) { return { ok: false, status: 'parse-error', message: e.message }; }
}

function captureTraffic() {
  const out = {};
  const endpoints = {
    clones:    `repos/${REPO}/traffic/clones`,
    views:     `repos/${REPO}/traffic/views`,
    referrers: `repos/${REPO}/traffic/popular/referrers`,
    paths:     `repos/${REPO}/traffic/popular/paths`,
  };
  for (const [key, ep] of Object.entries(endpoints)) {
    const r = ghJson(ep);
    if (r.ok) out[key] = r.data;
    else out[key] = { _error: r.message, _status: r.status };
  }
  return out;
}

function captureHeadline() {
  const r = ghJson(`repos/${REPO}`);
  if (!r.ok) return { _error: r.message };
  const d = r.data;
  return {
    stargazers_count: d.stargazers_count,
    forks_count:      d.forks_count,
    open_issues_count: d.open_issues_count,   // includes open PRs
    subscribers_count: d.subscribers_count,    // actual watchers
    network_count:    d.network_count,
    size_kb:          d.size,
    pushed_at:        d.pushed_at,
  };
}

const snapshot = {
  ts: new Date().toISOString(),
  repo: REPO,
  headline: captureHeadline(),
  traffic:  captureTraffic(),
};

fs.appendFileSync(OUT, JSON.stringify(snapshot) + '\n');

// Concise stdout summary
const t = snapshot.traffic;
const trafficOk = !t.clones._error && !t.views._error;
console.log(`[snapshot] ${snapshot.ts}`);
console.log(`  stars=${snapshot.headline.stargazers_count}  forks=${snapshot.headline.forks_count}  watchers=${snapshot.headline.subscribers_count}  open=${snapshot.headline.open_issues_count}`);
if (trafficOk) {
  const totalClones = (t.clones.count ?? 0), uniqClones = (t.clones.uniques ?? 0);
  const totalViews  = (t.views.count  ?? 0), uniqViews  = (t.views.uniques  ?? 0);
  console.log(`  traffic 14d: clones=${totalClones} (uniq=${uniqClones})  views=${totalViews} (uniq=${uniqViews})`);
  console.log(`  top referrer: ${t.referrers[0]?.referrer || '—'} (${t.referrers[0]?.count || 0} views)`);
} else {
  console.log(`  traffic: SKIPPED — ${t.clones._error || t.views._error}`);
}
console.log(`  appended to ${path.relative(process.cwd(), OUT)}`);
