// Tiny relay worker: cron-job.org calls THIS (not GitHub directly), and this
// worker makes the real workflow_dispatch call to GitHub server-side.
//
// Why this exists: cron-job.org's direct calls to api.github.com consistently
// got a 404 — even with byte-verified-correct URL, headers, and a token that
// works fine via plain curl. Everything on our side checks out, which points
// to GitHub/Fastly quietly blocking cron-job.org's shared IP pool or its
// self-identifying "cron-job.org" User-Agent (a known pattern: GitHub serves
// a misleading 404 instead of an honest 403 for these blocks, to avoid
// confirming what it's blocking). A Cloudflare Worker makes a normal
// server-to-server fetch() that looks like any other SaaS-to-GitHub
// integration, which avoids that class of block entirely.
//
// Bonus: your GitHub PAT never has to be pasted into cron-job.org's UI at
// all — only a short shared secret you invent goes there. The real PAT lives
// only as a Worker secret.
//
// Deploy: see ../README.md "Reliable triggering" section for click-by-click
// Cloudflare dashboard steps (no CLI, no account beyond a free signup).

const OWNER = 'hillynew';
const REPO = 'lg-shabbat-fridge';
const WORKFLOW_FILE = 'shabbat-tick.yml';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const suppliedSecret =
      request.headers.get('x-relay-secret') || url.searchParams.get('secret');

    if (!env.RELAY_SECRET || suppliedSecret !== env.RELAY_SECRET) {
      // Same 404 GitHub uses for "you're not allowed to know if this exists" —
      // no reason to confirm this endpoint's shape to an unauthenticated caller.
      return new Response('Not found', { status: 404 });
    }

    if (!env.GITHUB_PAT) {
      return new Response('Worker is missing its GITHUB_PAT secret', { status: 500 });
    }

    // TEMPORARY DIAGNOSTIC: a partial fingerprint of the stored token (never
    // the full value) so we can confirm what's actually stored vs. what was
    // meant to be pasted, without exposing the real secret. Remove once the
    // 404 mystery is solved.
    const pat = env.GITHUB_PAT;
    const fingerprint = `len=${pat.length} start="${pat.slice(0, 14)}" end="${pat.slice(-6)}" hasWhitespace=${/\s/.test(pat)}`;

    const force = url.searchParams.get('force') || '';
    // TEMPORARY: echo to httpbin instead of GitHub, to see exactly what this
    // Worker's fetch() actually sends over the wire (headers can be silently
    // altered by a runtime). Swap back to the real dispatchUrl once solved.
    const dispatchUrl = url.searchParams.get('echo') === '1'
      ? 'https://httpbin.org/anything'
      : `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;

    const githubResponse = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        // A normal, boring UA — nothing that self-identifies as a cron pinger.
        'User-Agent': 'lg-shabbat-fridge-relay-worker',
      },
      body: JSON.stringify({
        ref: 'main',
        ...(force === 'on' || force === 'off' ? { inputs: { force } } : {}),
      }),
    });

    const body = await githubResponse.text();
    return new Response(
      `GitHub responded ${githubResponse.status}${body ? `: ${body}` : ' (no body — this is the expected success response)'}\n\nDIAGNOSTIC token fingerprint: ${fingerprint}`,
      { status: githubResponse.status === 204 ? 200 : githubResponse.status },
    );
  },
};
