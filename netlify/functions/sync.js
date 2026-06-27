// On-demand dashboard refresh.
//
// The dashboard's "Sync now" button POSTs here. This dispatches the GitHub
// Actions "Refresh dashboard" workflow (refresh.yml), which re-pulls stats,
// rebuilds index.html, commits, and triggers a Netlify redeploy.
//
// Required Netlify env var:
//   GITHUB_SYNC_TOKEN — a fine-grained PAT scoped to this repo with
//                       "Actions: Read and write" permission.

const OWNER = 'Giri-Aayush';
const REPO = 'openhuma-githb-stats';
const WORKFLOW = 'refresh.yml';
const REF = 'main';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'Use POST' }) };
  }

  const token = process.env.GITHUB_SYNC_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: 'GITHUB_SYNC_TOKEN env var is not set in Netlify.' }),
    };
  }

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'openhuma-stats-sync',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REF }),
    });

    // GitHub returns 204 No Content on a successful dispatch.
    if (res.status === 204) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, message: 'Refresh dispatched.' }) };
    }

    const detail = await res.text().catch(() => '');
    return { statusCode: 502, body: JSON.stringify({ ok: false, status: res.status, detail }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ ok: false, error: String(err) }) };
  }
};
