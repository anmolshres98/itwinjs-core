// Invalidate all iTwin.js build status checks when master has a change to core/backend/package.json
// This is specifically to catch changes to @bentley/imodeljs-native and should only invalidate PRs that target master branch
// This will also invalidate PRs if there's a new nightly build, however our 3 hour rule should also invalidate the same PRs

const owner = "anmolshres98";
const repo = "itwinjs-core";
// Captured once, then removed from process.env so no spawned child process can read it.
const token = process.env.GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;

const headers = {
  "Authorization": `token ${token}`,
  "Accept": "application/vnd.github.v3+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "itwinjs-core-invalidate-open-prs",
};

const MAX_RETRIES = 4;
const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns the number of milliseconds to wait before retrying a rate-limited request,
// honoring `Retry-After` (seconds) or `X-RateLimit-Reset` (unix epoch seconds) when present.
function getRateLimitDelayMs(response) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null && !Number.isNaN(Number(retryAfter)))
    return Number(retryAfter) * 1000;

  const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  const rateLimitReset = response.headers.get("x-ratelimit-reset");
  if (rateLimitRemaining === "0" && rateLimitReset !== null && !Number.isNaN(Number(rateLimitReset)))
    return Math.max(0, Number(rateLimitReset) * 1000 - Date.now());

  return null;
}

function isRateLimited(response) {
  if (response.status === 429)
    return true;
  return response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
}

async function githubRequest(url, options = {}) {
  let attempt = 0;
  while (true) {
    let response;
    try {
      response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    } catch (networkError) {
      // Network-level failures (DNS, connection reset, timeout, etc.) - retry with backoff.
      if (attempt >= MAX_RETRIES)
        throw new Error(`GitHub API request to ${url} failed after ${attempt + 1} attempts: ${networkError.message}`);
      await sleep(2 ** attempt * 1000);
      attempt++;
      continue;
    }

    if (response.ok)
      return response;

    const isRetryableStatus = RETRYABLE_STATUS_CODES.has(response.status) || isRateLimited(response);
    if (!isRetryableStatus || attempt >= MAX_RETRIES)
      throw new Error(`GitHub API request to ${url} failed with ${response.status} ${response.statusText}: ${await response.text()}`);

    const rateLimitDelayMs = getRateLimitDelayMs(response);
    const delayMs = rateLimitDelayMs ?? 2 ** attempt * 1000;
    await sleep(delayMs);
    attempt++;
  }
}

const pullRequestsResponse = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/pulls`);
const pullRequests = await pullRequestsResponse.json();

for (const pullRequest of pullRequests) {
  if (!pullRequest.draft && pullRequest.base.ref === "master") {
    await githubRequest(`https://api.github.com/repos/${owner}/${repo}/statuses/${pullRequest.head.sha}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        state: "failure",
        description: "@bentley/imodeljs-native may be out of date with master, please merge",
        context: "iTwin.js",
      }),
    });
  }
}
