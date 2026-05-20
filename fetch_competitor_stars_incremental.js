// Incremental star fetcher. Reads the latest starredAt from the existing JSONL,
// then fetches DESC from GitHub, stopping when it crosses that timestamp.
// Designed for 4h refresh cycles after the initial backfill is complete.
//
// Usage: node fetch_competitor_stars_incremental.js <owner> <name>

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [, , owner, name] = process.argv;
if (!owner || !name) {
  console.error('usage: node fetch_competitor_stars_incremental.js <owner> <name>');
  process.exit(1);
}

const TOKEN = execSync('gh auth token').toString().trim();

const OUT_DIR = path.join(__dirname, 'data', 'competitors');
const slug = `${owner}_${name}`;
const STARS_PATH = path.join(OUT_DIR, `${slug}_stars.jsonl`);

if (!fs.existsSync(STARS_PATH)) {
  console.log(`[${slug}] no existing JSONL — run fetch_competitor_stars_fast.js first to backfill.`);
  process.exit(0);
}

// Find the latest starredAt — read just the tail of the file for efficiency
const content = fs.readFileSync(STARS_PATH, 'utf8');
const lines = content.split('\n').filter(Boolean);
const latestStarredAt = lines.length ? JSON.parse(lines[lines.length - 1]).starredAt : '1970-01-01T00:00:00Z';
console.log(`[${slug}] existing has ${lines.length} stars; latest=${latestStarredAt}`);

const QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    stargazers(first: 100, after: $cursor, orderBy: {field: STARRED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      edges { starredAt node { login } }
    }
  }
}
`;

async function fetchPage(cursor) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'openhuman-stats-incremental',
    },
    body: JSON.stringify({ query: QUERY, variables: { owner, name, cursor } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

async function main() {
  const newStars = [];
  let cursor = null;
  let page = 0;
  while (true) {
    page++;
    const body = await fetchPage(cursor);
    if (body.errors) { console.error('GraphQL errors:', body.errors); process.exit(2); }
    const sg = body.data.repository.stargazers;
    let done = false;
    for (const e of sg.edges) {
      if (e.starredAt <= latestStarredAt) { done = true; break; }
      newStars.push({ starredAt: e.starredAt, login: e.node.login });
    }
    if (done || !sg.pageInfo.hasNextPage) break;
    cursor = sg.pageInfo.endCursor;
  }

  if (!newStars.length) {
    console.log(`[${slug}] no new stars (checked ${page} pages).`);
    return;
  }
  // Sort ASC and append
  newStars.sort((a, b) => a.starredAt.localeCompare(b.starredAt));
  fs.appendFileSync(STARS_PATH, newStars.map(s => JSON.stringify(s)).join('\n') + '\n');
  console.log(`[${slug}] appended ${newStars.length} new stars (latest=${newStars[newStars.length - 1].starredAt}).`);
}

main().catch(e => { console.error(e); process.exit(1); });
