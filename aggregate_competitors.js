// Build comparison data from competitor star history + headline counts.
// Two views per repo:
//   - calendar:        weekly buckets aligned to absolute dates (Friday->Thursday)
//   - sinceGenesis:    weekly buckets aligned to "weeks since repo creation"
// Output: data/competitors/metrics.json

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data', 'competitors');
const HEADLINES = JSON.parse(fs.readFileSync(path.join(DIR, 'headlines.json'), 'utf8'));

function weekKey(isoDate) {
  // Friday-start week (matches main dashboard)
  const d = new Date(isoDate);
  const day = d.getUTCDay();
  const diff = (day + 2) % 7;
  const friday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return friday.toISOString().slice(0, 10);
}

function readStarsJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function processRepo(headline) {
  const [owner, name] = headline.full_name.split('/');
  const slug = `${owner}_${name}`;
  // openhuman shares the same JSONL the main dashboard uses
  const starsPath = headline.full_name === 'tinyhumansai/openhuman'
    ? path.join(__dirname, 'data', 'stars.jsonl')
    : path.join(DIR, `${slug}_stars.jsonl`);
  const cursorPath = path.join(DIR, `${slug}_stars.cursor`);

  const created = new Date(headline.created_at);
  const ageDays = Math.floor((Date.now() - created.getTime()) / 86400000);

  const stars = readStarsJsonl(starsPath);
  const expected = headline.stargazers_count;
  const dataReady = stars.length >= expected * 0.95 && !fs.existsSync(cursorPath);

  // Build weekly buckets — Friday-aligned, calendar view
  const calendarByWeek = {};
  for (const s of stars) {
    const w = weekKey(s.starredAt);
    calendarByWeek[w] = (calendarByWeek[w] || 0) + 1;
  }

  // Since-genesis view: bucket by "weeks since creation"
  const genesisWeek = weekKey(headline.created_at);
  const genesisMs = new Date(genesisWeek).getTime();
  const sinceGenesisByWeek = {}; // key = week-index (0, 1, 2, ...)
  for (const s of stars) {
    const ms = new Date(weekKey(s.starredAt)).getTime();
    const idx = Math.floor((ms - genesisMs) / (7 * 86400000));
    if (idx < 0) continue;
    sinceGenesisByWeek[idx] = (sinceGenesisByWeek[idx] || 0) + 1;
  }

  // Convert to arrays
  const calendarWeeks = Object.keys(calendarByWeek).sort();
  const calendarSeries = calendarWeeks.map(w => calendarByWeek[w]);
  let cum = 0;
  const calendarCumulative = calendarSeries.map(v => (cum += v));

  const maxIdx = Math.max(0, ...Object.keys(sinceGenesisByWeek).map(Number));
  const sinceGenesisWeekly = [];
  const sinceGenesisCumulative = [];
  cum = 0;
  for (let i = 0; i <= maxIdx; i++) {
    const v = sinceGenesisByWeek[i] || 0;
    sinceGenesisWeekly.push(v);
    sinceGenesisCumulative.push(cum += v);
  }

  // Velocity: lifetime + last 30 days
  const last30Start = Date.now() - 30 * 86400000;
  const last30 = stars.filter(s => new Date(s.starredAt).getTime() >= last30Start).length;
  const starsPerDayLife = ageDays > 0 ? (headline.stargazers_count / ageDays) : 0;
  const starsPerDay30 = last30 / 30;

  // Top spike weeks (ranked by stars gained)
  const topSpikes = calendarWeeks
    .map((week, i) => ({
      weekIso: week,
      stars: calendarSeries[i],
      weeksSinceGenesis: Math.floor((new Date(week).getTime() - genesisMs) / (7 * 86400000)),
      pctOfTotal: expected ? (calendarSeries[i] / expected) * 100 : 0,
    }))
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 5);

  return {
    fullName: headline.full_name,
    description: headline.description,
    createdAt: headline.created_at,
    ageDays,
    current: {
      stars:    headline.stargazers_count,
      forks:    headline.forks_count,
      watchers: headline.subscribers_count,
      openIssues: headline.open_issues_count,
    },
    velocity: {
      lifetime:   starsPerDayLife,
      last30Days: starsPerDay30,
      forkRatio:  headline.stargazers_count ? headline.forks_count / headline.stargazers_count : 0,
    },
    history: {
      dataReady,
      starsCollected: stars.length,
      starsExpected:  expected,
      calendar: { weeks: calendarWeeks, weekly: calendarSeries, cumulative: calendarCumulative },
      sinceGenesis: { weeklyIndex: sinceGenesisWeekly.map((_, i) => i), weekly: sinceGenesisWeekly, cumulative: sinceGenesisCumulative },
    },
    topSpikes,
  };
}

const repos = HEADLINES.map(processRepo);

// Order: openhuman first (our repo), then competitors by stars desc
repos.sort((a, b) => {
  if (a.fullName === 'tinyhumansai/openhuman') return -1;
  if (b.fullName === 'tinyhumansai/openhuman') return 1;
  return b.current.stars - a.current.stars;
});

const out = {
  generatedAt: new Date().toISOString(),
  repos,
};

fs.writeFileSync(path.join(DIR, 'metrics.json'), JSON.stringify(out, null, 2));
console.log('Wrote data/competitors/metrics.json');
for (const r of repos) {
  console.log(`  ${r.fullName.padEnd(32)} stars=${r.current.stars}  age=${r.ageDays}d  history=${r.history.dataReady ? 'READY' : `partial (${r.history.starsCollected}/${r.history.starsExpected})`}`);
}
