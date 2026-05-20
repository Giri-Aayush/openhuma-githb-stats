// Aggregate weekly + business metrics from GitHub data
const fs = require('fs');

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}
const prs = readJsonl('data/prs.jsonl');
const stars = readJsonl('data/stars.jsonl');
const commits = readJsonl('data/commits.jsonl');
const forks = readJsonl('data/forks.jsonl');
const issuesAndPrs = readJsonl('data/issues.jsonl');
const starProfiles = readJsonl('data/stargazer_profiles.jsonl');

const FOUNDERS = new Set(['senamakel', 'graycyrus', 'M3gA-Mind', 'CodeGhost21']);
const GENESIS_PUBLIC = '2026-02-18'; // repo went public
const GENESIS_CODE = '2026-01-26';   // first commit (pre-existing private repo)

// --- helpers ----------------------------------------------------
// Weeks run Friday -> Thursday. weekKey returns the YYYY-MM-DD of the Friday.
function weekKey(isoDate) {
  const d = new Date(isoDate);
  const day = d.getUTCDay();        // 0=Sun..6=Sat
  const diff = (day + 2) % 7;       // days since most recent Friday (day=5)
  const friday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return friday.toISOString().slice(0, 10);
}
function allWeeks(startIso, endIso) {
  const out = [];
  let cur = new Date(weekKey(startIso));
  const end = new Date(weekKey(endIso));
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 7 * 24 * 3600 * 1000);
  }
  return out;
}
function cumulative(arr) { let s = 0; return arr.map(v => (s += v)); }
function zeroByWeek(weeks) { return Object.fromEntries(weeks.map(w => [w, 0])); }
function allDays(startIso, endIso) {
  const out = [];
  const start = new Date(startIso.slice(0, 10) + 'T00:00:00Z');
  const end   = new Date(endIso.slice(0, 10)   + 'T00:00:00Z');
  for (let t = start; t <= end; t = new Date(t.getTime() + 86400000)) {
    out.push(t.toISOString().slice(0, 10));
  }
  return out;
}
function zeroByDay(days) { return Object.fromEntries(days.map(d => [d, 0])); }
const today = new Date().toISOString();
const weeks = allWeeks(GENESIS_PUBLIC, today);
const days  = allDays(GENESIS_PUBLIC, today);

// --- basic series (PRs / stars / contributors) -------------------
const prByWeek = zeroByWeek(weeks);
const prByDay  = zeroByDay(days);
for (const pr of prs) {
  const w = weekKey(pr.created_at);
  if (w in prByWeek) prByWeek[w]++;
  const d = pr.created_at.slice(0, 10);
  if (d in prByDay) prByDay[d]++;
}

const starByWeek = zeroByWeek(weeks);
const starByDay  = zeroByDay(days);
for (const s of stars) {
  if (!s.starredAt) continue;
  const w = weekKey(s.starredAt);
  if (w in starByWeek) starByWeek[w]++;
  const d = s.starredAt.slice(0, 10);
  if (d in starByDay) starByDay[d]++;
}

// First-commit per author login (drives "unique contributors") — both day & week
const firstSeenWeek = {};
const firstSeenDay  = {};
const sortedCommits = commits
  .map(c => ({ login: c.author_login || 'unknown', date: c.date }))
  .filter(c => c.date)
  .sort((a, b) => new Date(a.date) - new Date(b.date));
for (const c of sortedCommits) {
  if (!(c.login in firstSeenWeek)) firstSeenWeek[c.login] = weekKey(c.date);
  if (!(c.login in firstSeenDay))  firstSeenDay[c.login]  = c.date.slice(0, 10);
}
const newContribByWeek = zeroByWeek(weeks);
const newExternalContribByWeek = zeroByWeek(weeks);
for (const [login, w] of Object.entries(firstSeenWeek)) {
  if (!(w in newContribByWeek)) continue;
  newContribByWeek[w]++;
  if (!FOUNDERS.has(login) && !login.includes('[bot]')) newExternalContribByWeek[w]++;
}
const newContribByDay = zeroByDay(days);
const newExternalContribByDay = zeroByDay(days);
for (const [login, d] of Object.entries(firstSeenDay)) {
  if (!(d in newContribByDay)) continue;
  newContribByDay[d]++;
  if (!FOUNDERS.has(login) && !login.includes('[bot]')) newExternalContribByDay[d]++;
}

// --- external PR breakdown ---------------------------------------
const prsByWeekExternal = zeroByWeek(weeks);
const prsByWeekFounders = zeroByWeek(weeks);
const prsByDayExternal  = zeroByDay(days);
const prsByDayFounders  = zeroByDay(days);
const externalPrAuthors = new Set();
for (const pr of prs) {
  const w = weekKey(pr.created_at);
  const d = pr.created_at.slice(0, 10);
  const login = pr.user;
  if (!login) continue;
  if (FOUNDERS.has(login)) {
    if (w in prsByWeekFounders) prsByWeekFounders[w]++;
    if (d in prsByDayFounders)  prsByDayFounders[d]++;
  } else {
    if (w in prsByWeekExternal) prsByWeekExternal[w]++;
    if (d in prsByDayExternal)  prsByDayExternal[d]++;
    externalPrAuthors.add(login);
  }
}

// --- forks: good vs bad ------------------------------------------
const prAuthors = new Set(prs.map(p => p.user).filter(Boolean));
let contributingForks = 0;
let standaloneForks = 0; // fork has its own stargazers (>=1)
let driveByForks = 0;
const forkCategorySamples = { contributing: [], standalone: [], driveby: [] };
const forksByWeek = zeroByWeek(weeks);
const goodForksByWeek = zeroByWeek(weeks);
const forksByDay  = zeroByDay(days);
const goodForksByDay = zeroByDay(days);
for (const f of forks) {
  const w = weekKey(f.created_at);
  const d = f.created_at.slice(0, 10);
  if (w in forksByWeek) forksByWeek[w]++;
  if (d in forksByDay)  forksByDay[d]++;
  const owner = f.owner;
  const ownStars = f.stargazers_count || 0;
  const isContributing = owner && prAuthors.has(owner);
  if (isContributing) {
    contributingForks++;
    if (w in goodForksByWeek) goodForksByWeek[w]++;
    if (d in goodForksByDay)  goodForksByDay[d]++;
    if (forkCategorySamples.contributing.length < 10)
      forkCategorySamples.contributing.push({ owner, stars: ownStars, url: f.html_url });
  } else if (ownStars >= 1) {
    standaloneForks++;
    if (forkCategorySamples.standalone.length < 10)
      forkCategorySamples.standalone.push({ owner, stars: ownStars, url: f.html_url });
  } else {
    driveByForks++;
  }
}

// --- momentum / spike retention ----------------------------------
const dailyStars = days.map(d => starByDay[d]);
const rolling7 = dailyStars.map((_, i) => {
  const lo = Math.max(0, i - 6);
  return dailyStars.slice(lo, i + 1).reduce((a, b) => a + b, 0) / Math.min(7, i + 1);
});

// Identify spike: the week with max stars
const starsByWeekArr = weeks.map(w => starByWeek[w]);
const maxWeekIdx = starsByWeekArr.indexOf(Math.max(...starsByWeekArr));
const spikeWeek = weeks[maxWeekIdx];
const spikeStars = starsByWeekArr[maxWeekIdx];
const preSpikeAvg = maxWeekIdx > 0
  ? starsByWeekArr.slice(0, maxWeekIdx).reduce((a, b) => a + b, 0) / maxWeekIdx
  : 0;
const postSpike = starsByWeekArr.slice(maxWeekIdx + 1);
const postSpikeAvg = postSpike.length ? postSpike.reduce((a, b) => a + b, 0) / postSpike.length : null;
const retentionPct = postSpikeAvg != null && spikeStars > 0
  ? (postSpikeAvg / spikeStars) * 100 : null;
const liftVsPreSpike = postSpikeAvg != null && preSpikeAvg > 0
  ? (postSpikeAvg / preSpikeAvg) : null;

// Week-over-week growth rates
function wowGrowth(arr) {
  return arr.map((v, i) => {
    if (i === 0 || arr[i - 1] === 0) return null;
    return ((v - arr[i - 1]) / arr[i - 1]) * 100;
  });
}

// --- notable stargazers ------------------------------------------
// Curated tier-1 company keywords (lowercased substring match).
const TIER1 = [
  'google', 'alphabet', 'deepmind', 'meta', 'facebook', 'apple', 'amazon', 'aws',
  'microsoft', 'github', 'openai', 'anthropic', 'nvidia', 'tesla', 'netflix',
  'stripe', 'shopify', 'cloudflare', 'databricks', 'snowflake', 'palantir',
  'uber', 'airbnb', 'linkedin', 'twitter', 'x corp', 'spacex', 'oracle', 'ibm',
  'intel', 'amd', 'qualcomm', 'salesforce', 'adobe', 'samsung', 'sony',
  'baidu', 'alibaba', 'tencent', 'bytedance', 'tiktok', 'spotify', 'reddit',
  'discord', 'slack', 'atlassian', 'datadog', 'mongodb', 'elastic', 'hashicorp',
  'redhat', 'canonical', 'vercel', 'netlify', 'supabase', 'replit',
  'huggingface', 'hugging face', 'mistral', 'cohere', 'perplexity',
  'jpmorgan', 'goldman', 'morgan stanley', 'citadel', 'jane street', 'two sigma',
  'figma', 'notion', 'linear', 'asana', 'square', 'block', 'coinbase',
];
function normCompany(c) {
  if (!c) return null;
  return c.replace(/^@/, '').trim();
}
function isTier1(company) {
  if (!company) return false;
  const lc = company.toLowerCase();
  return TIER1.some(k => lc.includes(k));
}

const withCompany = starProfiles.filter(p => normCompany(p.company));
const tier1Stargazers = starProfiles
  .filter(p => isTier1(normCompany(p.company)))
  .map(p => ({
    login: p.login,
    name: p.name,
    company: normCompany(p.company),
    location: p.location,
    bio: p.bio,
    starredAt: p.starredAt,
    url: `https://github.com/${p.login}`,
  }))
  .sort((a, b) => new Date(b.starredAt) - new Date(a.starredAt));

// Company tally (normalized lower-case)
const companyTally = {};
for (const p of withCompany) {
  const norm = normCompany(p.company).toLowerCase();
  if (!norm) continue;
  companyTally[norm] = (companyTally[norm] || 0) + 1;
}
const topCompanies = Object.entries(companyTally)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30)
  .map(([company, count]) => ({ company, count }));

// Location tally
const locTally = {};
for (const p of starProfiles) {
  if (!p.location) continue;
  const norm = p.location.trim();
  locTally[norm] = (locTally[norm] || 0) + 1;
}
const topLocations = Object.entries(locTally)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .map(([location, count]) => ({ location, count }));

// --- issue authors (from issues.json) ----------------------------
// Filter to actual issues (no PR), check author profiles for company
const onlyIssues = issuesAndPrs.filter(i => !i.is_pr);
const issueAuthorLogins = new Set(onlyIssues.map(i => i.user).filter(Boolean));
const externalIssueAuthors = [...issueAuthorLogins].filter(l => !FOUNDERS.has(l));

// --- build output -------------------------------------------------
const out = {
  repo: 'tinyhumansai/openhuman',
  genesisPublic: GENESIS_PUBLIC,
  genesisCode: GENESIS_CODE,
  generatedAt: new Date().toISOString(),
  founders: [...FOUNDERS],
  totals: {
    prs: prs.length,
    stars: stars.length,
    forks: forks.length,
    uniqueContributors: Object.keys(firstSeenWeek).length,
    externalContributors: Object.keys(firstSeenWeek).filter(l => !FOUNDERS.has(l) && !l.includes('[bot]')).length,
    externalPrAuthors: externalPrAuthors.size,
    issuesNonPr: onlyIssues.length,
    externalIssueAuthors: externalIssueAuthors.length,
    weeks: weeks.length,
    stargazersWithCompany: withCompany.length,
    tier1Stargazers: tier1Stargazers.length,
  },
  forkBreakdown: {
    total: forks.length,
    contributing: contributingForks,
    standalone: standaloneForks,
    driveBy: driveByForks,
    samples: forkCategorySamples,
  },
  weeks,
  days,
  weekly: {
    prs: weeks.map(w => prByWeek[w]),
    prsExternal: weeks.map(w => prsByWeekExternal[w]),
    prsFounders: weeks.map(w => prsByWeekFounders[w]),
    stars: weeks.map(w => starByWeek[w]),
    newContributors: weeks.map(w => newContribByWeek[w]),
    newExternalContributors: weeks.map(w => newExternalContribByWeek[w]),
    forks: weeks.map(w => forksByWeek[w]),
    goodForks: weeks.map(w => goodForksByWeek[w]),
  },
  daily: {
    prs: days.map(d => prByDay[d]),
    prsExternal: days.map(d => prsByDayExternal[d]),
    prsFounders: days.map(d => prsByDayFounders[d]),
    stars: dailyStars,
    newContributors: days.map(d => newContribByDay[d]),
    newExternalContributors: days.map(d => newExternalContribByDay[d]),
    forks: days.map(d => forksByDay[d]),
    goodForks: days.map(d => goodForksByDay[d]),
  },
  cumulative: {
    prs: cumulative(weeks.map(w => prByWeek[w])),
    stars: cumulative(weeks.map(w => starByWeek[w])),
    contributors: cumulative(weeks.map(w => newContribByWeek[w])),
    externalContributors: cumulative(weeks.map(w => newExternalContribByWeek[w])),
    forks: cumulative(weeks.map(w => forksByWeek[w])),
    goodForks: cumulative(weeks.map(w => goodForksByWeek[w])),
  },
  dailyCumulative: {
    prs: cumulative(days.map(d => prByDay[d])),
    prsExternal: cumulative(days.map(d => prsByDayExternal[d])),
    prsFounders: cumulative(days.map(d => prsByDayFounders[d])),
    stars: cumulative(dailyStars),
    newContributors: cumulative(days.map(d => newContribByDay[d])),
    newExternalContributors: cumulative(days.map(d => newExternalContribByDay[d])),
    forks: cumulative(days.map(d => forksByDay[d])),
    goodForks: cumulative(days.map(d => goodForksByDay[d])),
  },
  momentum: {
    days,
    dailyStars,
    rolling7DayAvg: rolling7,
    spikeWeek,
    spikeStars,
    preSpikeAvg,
    postSpikeAvg,
    retentionPct,        // % of spike that post-spike sustains
    liftVsPreSpike,       // multiplier vs pre-spike baseline
    wowStarsPct: wowGrowth(starsByWeekArr),
    wowPrsPct: wowGrowth(weeks.map(w => prByWeek[w])),
  },
  pipeline: {
    tier1Stargazers,
    topCompanies,
    topLocations,
  },
};

fs.writeFileSync('data/metrics.json', JSON.stringify(out, null, 2));
console.log('Wrote data/metrics.json');
console.log('Totals:', out.totals);
console.log('Forks:', out.forkBreakdown);
console.log('Tier-1 stargazers:', out.pipeline.tier1Stargazers.length);
console.log('Top 5 companies:', out.pipeline.topCompanies.slice(0, 5));
console.log('Momentum:', {
  spikeWeek: out.momentum.spikeWeek,
  spikeStars: out.momentum.spikeStars,
  postSpikeAvg: out.momentum.postSpikeAvg,
  retentionPct: out.momentum.retentionPct?.toFixed(1) + '%',
});
