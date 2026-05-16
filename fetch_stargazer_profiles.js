// Enrich all stargazers with profile data (company, bio, location) via GraphQL
// Uses `gh api graphql` to authenticate via existing gh CLI session.
const { execSync } = require('child_process');
const fs = require('fs');

const QUERY = `
query($cursor: String) {
  repository(owner: "tinyhumansai", name: "openhuman") {
    stargazers(first: 100, after: $cursor, orderBy: {field: STARRED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      edges {
        starredAt
        node {
          login
          name
          company
          bio
          location
          url
          createdAt
        }
      }
    }
  }
}
`;

function ghGraphql(query, vars) {
  const args = ['gh', 'api', 'graphql'];
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue;
    args.push('-F', `${k}=${v}`);
  }
  args.push('-f', `query=${query}`);
  // Use spawnSync to avoid shell quoting issues
  const { spawnSync } = require('child_process');
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error('gh api graphql failed: ' + r.stderr);
  }
  return JSON.parse(r.stdout);
}

const all = [];
let cursor = null;
let page = 0;
while (true) {
  page++;
  const res = ghGraphql(QUERY, { cursor });
  const edges = res.data.repository.stargazers.edges;
  for (const e of edges) {
    all.push({
      starredAt: e.starredAt,
      login: e.node.login,
      name: e.node.name,
      company: e.node.company,
      bio: e.node.bio,
      location: e.node.location,
      createdAt: e.node.createdAt,
    });
  }
  process.stdout.write(`page ${page}  cumulative=${all.length}\n`);
  const info = res.data.repository.stargazers.pageInfo;
  if (!info.hasNextPage) break;
  cursor = info.endCursor;
}

fs.writeFileSync('data/stargazer_profiles.json', JSON.stringify(all, null, 2));
console.log('Wrote data/stargazer_profiles.json with ' + all.length + ' records');
