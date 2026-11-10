# Security Policy

## Reporting a Vulnerability

If you think you've found a security issue, please report it privately instead of opening a public issue.

**Email:** integrations@zerobounce.net (use a subject like `[zerobounce-cloudflare-worker] Security`).

We'll look into reports as we can. If the issue is in the ZeroBounce API or service rather than this Worker, we may forward it to the right team.

## Supported Versions

We focus on the current state of `main`. Deploying the latest version of the Worker script is recommended.

## Tips for Deploying This Worker

* The API key is read from the `API_KEY` environment binding. Add it as an **encrypted secret** in the Cloudflare dashboard (Workers -> Settings -> Variables and Secrets) or with `wrangler secret put API_KEY`. Never paste it into the Worker source, a `wrangler.toml`, a log line, or a commit.
* The Worker rewrites request bodies that are already in flight to your origin. Keep `BYPASS_PATH` set for any route that must never be touched, such as login or payment endpoints.
* Submitted email addresses are sent to the ZeroBounce API, and are written to the `LOGS` KV namespace when that binding exists. Treat that namespace as personal data: restrict access and set an expiry that matches your retention policy.
* `API_REGION` lets you pin validation traffic to the US or EU host if your deployment has data residency requirements.
* Keep the GitHub Actions in `.github/workflows/` pinned to a commit SHA, and let Dependabot's security updates move them.

Thanks for helping keep things secure.
