// FORK VERIFICATION COPY — identical to the real script except owner points at the fork.
// Do not merge upstream. Used only to prove the new fetch-based flow on a real runner.

const owner = "anmolshres98";
const repo = "itwinjs-core";
const token = process.env.GITHUB_TOKEN;

const headers = {
  "Authorization": `token ${token}`,
  "Accept": "application/vnd.github.v3+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "itwinjs-core-invalidate-open-prs",
};

async function githubRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (!response.ok)
    throw new Error(`GitHub API request to ${url} failed with ${response.status} ${response.statusText}: ${await response.text()}`);
  return response;
}

const pullRequestsResponse = await githubRequest(`https://api.github.com/repos/${owner}/${repo}/pulls`);
const pullRequests = await pullRequestsResponse.json();

for (const pullRequest of pullRequests) {
  if (!pullRequest.draft && pullRequest.base.ref === "master") {
    console.log(`Invalidating PR #${pullRequest.number} (head ${pullRequest.head.sha})`);
    await githubRequest(`https://api.github.com/repos/${owner}/${repo}/statuses/${pullRequest.head.sha}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        state: "failure",
        description: "@bentley/imodeljs-native may be out of date with master, please merge",
        context: "iTwin.js",
      }),
    });
  } else {
    console.log(`Skipping PR #${pullRequest.number} (draft=${pullRequest.draft}, base=${pullRequest.base.ref})`);
  }
}
