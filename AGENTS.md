# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

`cloudflare-worker-zerobounce.js` is a single Cloudflare Worker that sits in front of a customer's own site. It
intercepts POST requests on the route it is deployed to, pulls the email address out of the body, validates it with the
ZeroBounce real-time API, and either forwards the original request or forwards a copy with the address replaced by the
literal string `INVALID`. There is no package, no build step and no bundler: the file is the deployable artifact, and
the integration guide at <https://www.zerobounce.net/docs/api-integrations/cloudflare-worker> points at it.

It is written in the **service-worker syntax** (`addEventListener("fetch", ...)`), not the newer module syntax. That is
why configuration arrives as bare globals rather than an `env` argument, and why every binding is read behind a
`typeof X !== 'undefined'` guard.

## Layout

- `cloudflare-worker-zerobounce.js`: the whole Worker.
- `tests/worker.test.js`: the offline suite. It evaluates the Worker source in a fresh `node:vm` context per test, with
  a fake `fetch` and the bindings under test as context globals.
- `.github/workflows/sdk_ci.yml`: parse check plus the test suite.

## Commands

```bash
npm run lint   # node --check cloudflare-worker-zerobounce.js
npm test       # node --test
```

Node.js 20 or newer. There are no dependencies and no lockfile; do not add one without a reason.

## Environment bindings

All of them are optional, and the Worker degrades to a pass-through when one is missing.

| Binding | Purpose |
| --- | --- |
| `API_KEY` | ZeroBounce API key, an encrypted secret. Without it no validation happens. |
| `API_REGION` | `us`, `eu`, or unset/`global` for the default host. |
| `API_TIMEOUT` | Milliseconds, passed to `AbortSignal.timeout`. |
| `VALID_STATUS` | Allow-list of ZeroBounce statuses. A status outside it is rewritten to `INVALID`. |
| `BYPASS_PATH` | Paths that are forwarded untouched. |
| `LOGS` | KV namespace. When bound, each validation result is written to it. |

## Conventions

- **Never commit an API key**, and never write one into a test, a fixture, a log line or a sample `wrangler.toml`. The
  tests use an obvious placeholder.
- **Tests stay offline.** `fetch` is always faked. Do not add a test that calls the live ZeroBounce API; a 403 with
  `error code: 1020` from a placeholder key is a sign a test tried.
- **The key goes in the `api_key` query parameter**, which is what the API expects. It is never put in a header, and
  never logged: `logValidation` records the *incoming* request's pathname, not the validation URL.
- **There is no regional bulk or warm-up host.** `API_REGION` applies to `/v2/validate` only. `API_REGION` is matched
  against a fixed allow-list and an unrecognised value falls back to the global host, so a typo cannot redirect the key.
- **The three regexes are deliberate and fragile.** They are flagged `DO NOT EDIT!` upstream, they are built from
  strings (so every backslash is doubled), and the capture groups feed `$1INVALID` replacements. Do not "tidy" them.
- **The Content-Type of a rewritten request is inherited from the incoming request.** When you change a body, keep its
  encoding: handing a `FormData` object to a request that still carries
  `Content-Type: application/x-www-form-urlencoded` produces a multipart body the origin cannot parse.
- **Keep the pass-through guarantee.** Every branch ends in `return await fetch(request)`, and
  `event.passThroughOnException()` means a thrown error silently forwards to the origin. A change that can hang or
  throw before that point breaks the customer's form instead of their bad addresses.
- **Match the surrounding style**: four-space indent, `console.log` for tracing, JSDoc blocks above each function. Do
  not reformat unrelated code and do not rewrite the Worker wholesale.

## Known quirks (deliberately left alone)

Changing these would alter live behaviour, so they are documented rather than fixed. Raise them with a maintainer first.

- The URL-encoded branch compares `contentType === 'application/x-www-form-urlencoded'` exactly, so a request whose
  header carries a charset (`...; charset=UTF-8`) is forwarded without validation. The multipart and JSON branches use
  `includes` instead.
- In the JSON branch, `Object.keys(_form).filter(...)` returns an array, which is always truthy, so the matching `else`
  branch is unreachable, and `_form[email_key]` only works while exactly one key starts with `email`.
- The `[\\r\\n]+` alternative in the first regex matches the literal characters `\`, `r`, `n` rather than a newline.
  The `\"\s+` alternative is what actually matches multipart bodies.
- The Worker is MIT, stated both in the file header and in `LICENSE`, matching the 13 SDK repositories.
  The header previously said `GPL-2.0+`; that was reconciled to MIT by the maintainer, not assumed.
