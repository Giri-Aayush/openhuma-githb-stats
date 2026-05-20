// Fetch ALL stargazers (with starred_at timestamps) for a single repo via GraphQL.
// Resumable: writes JSONL incrementally + a cursor file so an interrupted run picks
// up from the last page.
//
// Usage: node fetch_competitor_stars.js <owner> <name>

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [, , owner, name] = process.argv;
if (!owner || !name) {
  console.error('usage: node fetch_competitor_stars.js <owner> <name>');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'data', 'competitors');
fs.mkdirSync(OUT_DIR, { recursive: true });
const slug = `${owner}_${name}`;
const STARS_PATH  = path.join(OUT_DIR, `${slug}_stars.jsonl`);
const CURSOR_PATH = path.join(OUT_DIR, `${slug}_stars.cursor`);

const QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    stargazers(first: 100, after: $cursor, orderBy: {field: STARRED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      edges { starredAt node { login } }
    }
    stargazerCount
  }
  rateLimit { remaining resetAt }
}
`;

function gql(vars) {
  const args = ['api', 'graphql'];
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue;
    args.push('-F', `${k}=${v}`);
  }
  args.push('-f', `query=${QUERY}`);
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error('gh api failed: ' + (r.stderr || r.stdout));
  }
  return JSON.parse(r.stdout);
}

let cursor = null;
if (fs.existsSync(CURSOR_PATH)) {
  cursor = fs.readFileSync(CURSOR_PATH, 'utf8').trim() || null;
  console.log(`[${slug}] resuming from cursor ${cursor?.slice(0, 16)}...`);
} else {
  // Fresh start — truncate the JSONL
  fs.writeFileSync(STARS_PATH, '');
  console.log(`[${slug}] starting fresh`);
}

let total = 0;
if (fs.existsSync(STARS_PATH)) {
  // Count existing lines for resumption progress
  total = fs.readFileSync(STARS_PATH, 'utf8').split('\n').filter(Boolean).length;
}

const startedAt = Date.now();
let page = 0;
while (true) {
  page++;
  let res;
  try {
    res = gql({ owner, name, cursor });
  } catch (e) {
    // Rate limit or transient — sleep and retry
    console.error(`[${slug}] page ${page} error: ${e.message}. Sleeping 60s.`);
    require('child_process').execSync('sleep 60');
    continue;
  }
  if (res.errors) {
    console.error(`[${slug}] GraphQL errors:`, JSON.stringify(res.errors));
    process.exit(2);
  }
  const sg = res.data.repository.stargazers;
  const lines = sg.edges.map(e => JSON.stringify({ starredAt: e.starredAt, login: e.node.login })).join('\n');
  if (lines) fs.appendFileSync(STARS_PATH, lines + '\n');
  total += sg.edges.length;

  const rl = res.data.rateLimit;
  const totalReported = res.data.repository.stargazerCount;
  if (page % 20 === 0 || !sg.pageInfo.hasNextPage) {
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    const pct = totalReported ? ((total / totalReported) * 100).toFixed(1) : '?';
    console.log(`[${slug}] page ${page}  collected ${total}/${totalReported} (${pct}%)  rl=${rl.remaining}  elapsed=${elapsedMin}m`);
  }

  if (!sg.pageInfo.hasNextPage) {
    // Done
    if (fs.existsSync(CURSOR_PATH)) fs.unlinkSync(CURSOR_PATH);
    console.log(`[${slug}] DONE. ${total} stargazers in ${((Date.now() - startedAt) / 60000).toFixed(1)} min.`);
    break;
  }

  cursor = sg.pageInfo.endCursor;
  fs.writeFileSync(CURSOR_PATH, cursor);

  // Soft rate-limit handling: if budget low, sleep until reset
  if (rl.remaining < 100) {
    const resetMs = new Date(rl.resetAt).getTime() - Date.now();
    const waitSec = Math.max(5, Math.ceil(resetMs / 1000) + 10);
    console.log(`[${slug}] rate-limit low (${rl.remaining}). Sleeping ${waitSec}s until ${rl.resetAt}.`);
    require('child_process').execSync(`sleep ${waitSec}`);
  }
}
