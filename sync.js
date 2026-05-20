// Incremental sync of all openhuman GitHub data into append-only JSONL files.
// On first run (no JSONL files), fetches the full history. On subsequent runs,
// fetches only records created since the last known timestamp / id.
//
// Output files (all in data/):
//   stars.jsonl                — { starredAt, login }
//   prs.jsonl                  — { number, created_at, user, state, merged_at, title }
//   commits.jsonl              — { sha, date, author_login, message }
//   forks.jsonl                — { id, created_at, owner, stargazers_count, html_url }
//   issues.jsonl               — { number, created_at, user, state, is_pr, title }
//   stargazer_profiles.jsonl   — { login, name, company, bio, location, createdAt, starredAt }

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'tinyhumansai';
const REPO_NAME  = 'openhuman';
const REPO = `${REPO_OWNER}/${REPO_NAME}`;
const TOKEN = execSync('gh auth token').toString().trim();
const DATA_DIR = path.join(__dirname, 'data');

const COMMON_HEADERS = {
  'Authorization': `bearer ${TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'openhuman-stats-sync',
};

async function ghRest(url) {
  if (!url.startsWith('http')) url = `https://api.github.com${url}`;
  const res = await fetch(url, { headers: COMMON_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const link = res.headers.get('link');
  const nextLink = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  return { data: await res.json(), nextLink };
}

async function ghGraphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}
function appendJsonl(p, records) {
  if (!records.length) return;
  fs.appendFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// ============================================================================
// Stars (GraphQL, DESC, stop at known starredAt)
// ============================================================================
async function syncStars() {
  const out = path.join(DATA_DIR, 'stars.jsonl');
  const existing = readJsonl(out);
  const latest = existing.length ? existing[existing.length - 1].starredAt : '1970-01-01T00:00:00Z';

  const QUERY = `
    query($cursor: String) {
      repository(owner: "${REPO_OWNER}", name: "${REPO_NAME}") {
        stargazers(first: 100, after: $cursor, orderBy: {field: STARRED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          edges { starredAt node { login } }
        }
      }
    }`;
  const newRecords = [];
  let cursor = null;
  while (true) {
    const body = await ghGraphql(QUERY, { cursor });
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    const sg = body.data.repository.stargazers;
    let done = false;
    for (const e of sg.edges) {
      if (e.starredAt <= latest) { done = true; break; }
      newRecords.push({ starredAt: e.starredAt, login: e.node.login });
    }
    if (done || !sg.pageInfo.hasNextPage) break;
    cursor = sg.pageInfo.endCursor;
  }
  newRecords.sort((a, b) => a.starredAt.localeCompare(b.starredAt));
  appendJsonl(out, newRecords);
  console.log(`[stars] +${newRecords.length}  total=${existing.length + newRecords.length}`);
}

// ============================================================================
// PRs (REST, sort=created DESC, stop at known created_at)
// ============================================================================
async function syncPRs() {
  const out = path.join(DATA_DIR, 'prs.jsonl');
  const existing = readJsonl(out);
  const latest = existing.length ? existing[existing.length - 1].created_at : '1970-01-01T00:00:00Z';

  const newRecords = [];
  let url = `/repos/${REPO}/pulls?state=all&sort=created&direction=desc&per_page=100`;
  while (url) {
    const { data, nextLink } = await ghRest(url);
    let done = false;
    for (const pr of data) {
      if (pr.created_at <= latest) { done = true; break; }
      newRecords.push({
        number: pr.number, created_at: pr.created_at,
        user: pr.user?.login || null, state: pr.state,
        merged_at: pr.merged_at, title: pr.title,
      });
    }
    if (done) break;
    url = nextLink;
  }
  newRecords.sort((a, b) => a.created_at.localeCompare(b.created_at));
  appendJsonl(out, newRecords);
  console.log(`[prs] +${newRecords.length}  total=${existing.length + newRecords.length}`);
}

// ============================================================================
// Commits (REST, newest-first, stop at known sha)
// ============================================================================
async function syncCommits() {
  const out = path.join(DATA_DIR, 'commits.jsonl');
  const existing = readJsonl(out);
  const knownShas = new Set(existing.map(c => c.sha));

  const newRecords = [];
  let url = `/repos/${REPO}/commits?per_page=100`;
  while (url) {
    const { data, nextLink } = await ghRest(url);
    let done = false;
    for (const c of data) {
      if (knownShas.has(c.sha)) { done = true; break; }
      newRecords.push({
        sha: c.sha, date: c.commit?.author?.date,
        author_login: c.author?.login || c.commit?.author?.name || 'unknown',
        message: (c.commit?.message || '').slice(0, 160),
      });
    }
    if (done) break;
    url = nextLink;
  }
  newRecords.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  appendJsonl(out, newRecords);
  console.log(`[commits] +${newRecords.length}  total=${existing.length + newRecords.length}`);
}

// ============================================================================
// Forks (REST, sort=newest, stop at known id)
// ============================================================================
async function syncForks() {
  const out = path.join(DATA_DIR, 'forks.jsonl');
  const existing = readJsonl(out);
  const knownIds = new Set(existing.map(f => f.id));

  const newRecords = [];
  let url = `/repos/${REPO}/forks?sort=newest&per_page=100`;
  while (url) {
    const { data, nextLink } = await ghRest(url);
    let done = false;
    for (const f of data) {
      if (knownIds.has(f.id)) { done = true; break; }
      newRecords.push({
        id: f.id, created_at: f.created_at,
        owner: f.owner?.login || null,
        stargazers_count: f.stargazers_count || 0,
        html_url: f.html_url,
      });
    }
    if (done) break;
    url = nextLink;
  }
  newRecords.sort((a, b) => a.created_at.localeCompare(b.created_at));
  appendJsonl(out, newRecords);
  console.log(`[forks] +${newRecords.length}  total=${existing.length + newRecords.length}`);
}

// ============================================================================
// Issues (REST, sort=created DESC, stop at known created_at)
// ============================================================================
async function syncIssues() {
  const out = path.join(DATA_DIR, 'issues.jsonl');
  const existing = readJsonl(out);
  const latest = existing.length ? existing[existing.length - 1].created_at : '1970-01-01T00:00:00Z';

  const newRecords = [];
  let url = `/repos/${REPO}/issues?state=all&sort=created&direction=desc&per_page=100`;
  while (url) {
    const { data, nextLink } = await ghRest(url);
    let done = false;
    for (const i of data) {
      if (i.created_at <= latest) { done = true; break; }
      newRecords.push({
        number: i.number, created_at: i.created_at,
        user: i.user?.login || null, state: i.state,
        is_pr: !!i.pull_request, title: i.title,
      });
    }
    if (done) break;
    url = nextLink;
  }
  newRecords.sort((a, b) => a.created_at.localeCompare(b.created_at));
  appendJsonl(out, newRecords);
  console.log(`[issues] +${newRecords.length}  total=${existing.length + newRecords.length}`);
}

// ============================================================================
// Stargazer profile enrichment (batch GraphQL by user login)
// Only enriches stars that haven't been profiled yet.
// ============================================================================
async function syncStargazerProfiles() {
  const stars = readJsonl(path.join(DATA_DIR, 'stars.jsonl'));
  const out = path.join(DATA_DIR, 'stargazer_profiles.jsonl');
  const existing = readJsonl(out);
  const knownLogins = new Set(existing.map(p => p.login));

  // Star login -> starredAt (most recent wins)
  const starredAtByLogin = new Map();
  for (const s of stars) starredAtByLogin.set(s.login, s.starredAt);

  // Dedupe + filter to only new logins
  const toEnrich = [];
  const seen = new Set();
  for (const s of stars) {
    if (knownLogins.has(s.login) || seen.has(s.login)) continue;
    seen.add(s.login);
    toEnrich.push(s.login);
  }
  if (!toEnrich.length) { console.log('[profiles] +0  (no new stargazers to enrich)'); return; }

  const BATCH = 50;
  const newRecords = [];
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    const batch = toEnrich.slice(i, i + BATCH);
    const queryParts = batch.map((login, idx) =>
      `u${idx}: user(login: ${JSON.stringify(login)}) { login name company bio location createdAt }`
    ).join('\n');
    const query = `query { ${queryParts} }`;
    let body;
    try { body = await ghGraphql(query); }
    catch (e) { console.warn(`[profiles] batch ${i}-${i + batch.length} error: ${e.message}`); continue; }
    if (body.data) {
      for (const v of Object.values(body.data)) {
        if (!v || !v.login) continue;
        newRecords.push({
          login: v.login, name: v.name, company: v.company,
          bio: v.bio, location: v.location, createdAt: v.createdAt,
          starredAt: starredAtByLogin.get(v.login),
        });
      }
    }
  }
  appendJsonl(out, newRecords);
  console.log(`[profiles] +${newRecords.length}  total=${existing.length + newRecords.length}`);
}

// ============================================================================
async function main() {
  console.log(`==== sync started @ ${new Date().toISOString()}`);
  const t = Date.now();
  await syncStars();
  await syncPRs();
  await syncCommits();
  await syncForks();
  await syncIssues();
  await syncStargazerProfiles();
  console.log(`==== sync complete in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
