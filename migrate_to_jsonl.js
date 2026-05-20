// One-off migration: convert legacy data/*.json files into JSONL with the
// trimmed schema used by sync.js. Idempotent — skips files that don't exist
// and refuses to overwrite an existing JSONL.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

function migrate(name, fn) {
  const src = path.join(DATA_DIR, `${name}.json`);
  const dst = path.join(DATA_DIR, `${name}.jsonl`);
  if (!fs.existsSync(src)) { console.log(`[${name}] skip (no source)`); return; }
  if (fs.existsSync(dst))  { console.log(`[${name}] skip (jsonl exists)`); return; }
  const records = JSON.parse(fs.readFileSync(src, 'utf8')).map(fn).filter(Boolean);
  fs.writeFileSync(dst, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[${name}] migrated ${records.length} records → ${name}.jsonl`);
}

// Stars — legacy used { starred_at, user.login }
migrate('stars', s => s.starred_at && s.user ? { starredAt: s.starred_at, login: s.user.login } : null);

// PRs
migrate('prs', pr => ({
  number: pr.number, created_at: pr.created_at,
  user: pr.user?.login || null, state: pr.state,
  merged_at: pr.merged_at, title: pr.title,
}));

// Commits
migrate('commits', c => ({
  sha: c.sha, date: c.commit?.author?.date,
  author_login: c.author?.login || c.commit?.author?.name || 'unknown',
  message: (c.commit?.message || '').slice(0, 160),
}));

// Forks
migrate('forks', f => ({
  id: f.id, created_at: f.created_at,
  owner: f.owner?.login || null,
  stargazers_count: f.stargazers_count || 0,
  html_url: f.html_url,
}));

// Issues
migrate('issues', i => ({
  number: i.number, created_at: i.created_at,
  user: i.user?.login || null, state: i.state,
  is_pr: !!i.pull_request, title: i.title,
}));

// Stargazer profiles — legacy already had login/name/company/bio/location/createdAt/starredAt
migrate('stargazer_profiles', p => ({
  login: p.login, name: p.name, company: p.company,
  bio: p.bio, location: p.location, createdAt: p.createdAt,
  starredAt: p.starredAt,
}));

// Sort each JSONL by creation timestamp so append-only ordering is correct
function sortInPlace(name, key) {
  const p = path.join(DATA_DIR, `${name}.jsonl`);
  if (!fs.existsSync(p)) return;
  const records = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  records.sort((a, b) => (a[key] || '').localeCompare(b[key] || ''));
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[${name}] sorted by ${key}`);
}

sortInPlace('stars', 'starredAt');
sortInPlace('prs', 'created_at');
sortInPlace('commits', 'date');
sortInPlace('forks', 'created_at');
sortInPlace('issues', 'created_at');
sortInPlace('stargazer_profiles', 'starredAt');

console.log('Migration done.');
