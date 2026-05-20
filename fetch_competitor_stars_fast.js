// Like fetch_competitor_stars.js but uses native fetch() with gh's stored token,
// avoiding the per-request `gh` CLI process-spawn overhead (~1.5s -> ~0.3s per page).
//
// Usage: node fetch_competitor_stars_fast.js <owner> <name>

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [, , owner, name] = process.argv;
if (!owner || !name) {
  console.error('usage: node fetch_competitor_stars_fast.js <owner> <name>');
  process.exit(1);
}

const TOKEN = execSync('gh auth token').toString().trim();

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

async function fetchPage(cursor) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'openhuman-stats-fetcher',
    },
    body: JSON.stringify({ query: QUERY, variables: { owner, name, cursor } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

async function main() {
  let cursor = null;
  if (fs.existsSync(CURSOR_PATH)) {
    cursor = fs.readFileSync(CURSOR_PATH, 'utf8').trim() || null;
    console.log(`[${slug}] resuming from cursor ${cursor?.slice(0, 16)}...`);
  } else {
    fs.writeFileSync(STARS_PATH, '');
    console.log(`[${slug}] starting fresh`);
  }

  let total = fs.existsSync(STARS_PATH)
    ? fs.readFileSync(STARS_PATH, 'utf8').split('\n').filter(Boolean).length
    : 0;

  const startedAt = Date.now();
  let page = 0;

  while (true) {
    page++;
    let body;
    try {
      body = await fetchPage(cursor);
    } catch (e) {
      console.error(`[${slug}] page ${page} error: ${e.message}. Sleeping 30s.`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    if (body.errors) {
      // Transient GraphQL errors (NOT_FOUND on a repo that obviously exists,
      // intermittent 5xx-as-200, etc.) — retry with backoff instead of dying.
      console.error(`[${slug}] GraphQL errors page ${page}:`, JSON.stringify(body.errors));
      console.error(`[${slug}] sleeping 30s and retrying...`);
      await new Promise(r => setTimeout(r, 30000));
      page--;
      continue;
    }
    const sg = body.data.repository.stargazers;
    const lines = sg.edges.map(e => JSON.stringify({ starredAt: e.starredAt, login: e.node.login })).join('\n');
    if (lines) fs.appendFileSync(STARS_PATH, lines + '\n');
    total += sg.edges.length;

    const rl = body.data.rateLimit;
    const totalReported = body.data.repository.stargazerCount;
    if (page % 50 === 0 || !sg.pageInfo.hasNextPage) {
      const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
      const pct = totalReported ? ((total / totalReported) * 100).toFixed(1) : '?';
      console.log(`[${slug}] page ${page}  collected ${total}/${totalReported} (${pct}%)  rl=${rl.remaining}  elapsed=${elapsedMin}m`);
    }

    if (!sg.pageInfo.hasNextPage) {
      if (fs.existsSync(CURSOR_PATH)) fs.unlinkSync(CURSOR_PATH);
      console.log(`[${slug}] DONE. ${total} stargazers in ${((Date.now() - startedAt) / 60000).toFixed(1)} min.`);
      return;
    }

    cursor = sg.pageInfo.endCursor;
    fs.writeFileSync(CURSOR_PATH, cursor);

    if (rl.remaining < 100) {
      const waitSec = Math.max(5, Math.ceil((new Date(rl.resetAt).getTime() - Date.now()) / 1000) + 10);
      console.log(`[${slug}] rate-limit low (${rl.remaining}). Sleeping ${waitSec}s.`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
