# zerobounce-cloudflare-worker

Cloudflare Worker-based email validation

## Security

- The API key is read from the `API_KEY` environment binding. Add it as an **encrypted secret**, never in the Worker source or in a commit.
- Request URLs include `api_key` as a query parameter (ZeroBounce API contract). Do not log full request URLs in production.
- Submitted addresses are sent to the ZeroBounce API, and are stored in the `LOGS` KV namespace when that binding exists. Treat that namespace as personal data.
- See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Cloudflare Worker-based email validation with the ZeroBounce Email Validator
The ZeroBounce email validator now officially integrates with Cloudflare Workers to assist with email list cleaning. Through Cloudflare Worker’s super-computing platform Edge, you can integrate with ZeroBounce’s real-time email validation to prevent bounced emails and spam complaints while improving your email deliverability in real time.
## How Cloudflare Worker’s email validation middleware works
The Cloudflare worker intercepts any incoming POST requests on the route where it’s deployed. In other words, it examines any email address entered into your website form, validates it, and rejects or accepts the address based on the results.

## Cloudflare worker script
https://github.com/zerobounce/zerobounce-cloudflare-worker/blob/main/cloudflare-worker-zerobounce.js

The script is the deployable artifact: paste it into a Worker (Quick Edit) or deploy it with `wrangler`. It uses the
service-worker syntax, so its configuration comes from environment bindings rather than an `env` argument.

## Environment bindings

Set these under **Workers & Pages → your Worker → Settings → Variables and Secrets**, or in `wrangler.toml`. Every
binding is optional: when one is missing the Worker falls back to forwarding the request untouched.

| Binding | Type | Default | Purpose |
| --- | --- | --- | --- |
| `API_KEY` | Secret | — | Your ZeroBounce API key. Without it the Worker validates nothing. |
| `API_REGION` | Variable | `global` | Which ZeroBounce host to validate against: `global`, `us` or `eu`. |
| `API_TIMEOUT` | Variable | `10000` | Milliseconds before the validation request is aborted. A value that is not a positive number is logged and replaced by the default. |
| `VALID_STATUS` | Variable (JSON array) | — | Statuses you accept, e.g. `["valid","catch-all"]`. Anything else is rewritten to `INVALID`. |
| `BYPASS_PATH` | Variable (JSON array) | — | Paths to forward untouched, e.g. `["/wp-login.php"]`. |
| `LOGS` | KV namespace | — | When bound, every validation result is written to it. |

### When validation fails

The Worker fails open: if the validation request cannot produce a status (an invalid or drained API key, a timeout, a
network error, a redirect, or any other API error), the submission is forwarded to your origin unvalidated, exactly as
if the Worker were not there. Each such failure is logged with `console.error` (visible in Workers Logs and
`wrangler tail`), naming the cause and the API's own message, so a dead key does not go unnoticed. The API key itself is
never logged. The validation request does not follow redirects, since its URL carries the key.

The Worker logs which address it validated and the result, but never a submitted form body, which can hold passwords.

### Choosing a region

ZeroBounce serves the real-time validation API from three interchangeable hosts. `api.zerobounce.net` is the global
entry point; `api-us.zerobounce.net` and `api-eu.zerobounce.net` pin traffic to one region, which some deployments need
for data residency.

| `API_REGION` | Endpoint used |
| --- | --- |
| unset, `global` or `default` | `https://api.zerobounce.net/v2/validate` |
| `us` (or `usa`) | `https://api-us.zerobounce.net/v2/validate` |
| `eu` | `https://api-eu.zerobounce.net/v2/validate` |

The value is case-insensitive and surrounding whitespace is ignored. An unrecognised value falls back to the global
host and logs a line, so a typo cannot send your API key somewhere unintended.

Leaving `API_REGION` unset keeps the exact behaviour of earlier versions of this Worker, so existing deployments do not
need any change.

ZeroBounce documents no regional bulk or warm-up host, so this setting applies to the single-email `/v2/validate`
endpoint only.

```toml
# wrangler.toml
name = "zerobounce-email-validator"
main = "cloudflare-worker-zerobounce.js"
compatibility_date = "2024-01-01"

[vars]
API_REGION = "eu"
API_TIMEOUT = 5000
VALID_STATUS = ["valid", "catch-all"]
BYPASS_PATH = ["/wp-login.php"]

# API_KEY is a secret: wrangler secret put API_KEY
```

## Development

Node.js 22 or newer. There are no dependencies to install.

```bash
npm run lint   # node --check on the Worker source
npm test       # node --test, fully offline
```

The suite in `tests/` evaluates the Worker in a `node:vm` context with a fake `fetch`, and covers the region selection,
the shape of the validation request, the `VALID_STATUS` gate, timeouts, redirects and failed validations. It never
calls the live ZeroBounce API. The run ends with a summary; `fail 0` means every test passed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
