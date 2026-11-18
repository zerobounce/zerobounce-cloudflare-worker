# zerobounce-cloudflare-worker

Cloudflare Worker-based email validation

## Security

- The API key is read from the `API_KEY` environment binding. Add it as an **encrypted secret**, never in the Worker source or in a commit.
- Request URLs include `api_key` as a query parameter (ZeroBounce API contract). Do not log full request URLs in production.
- Submitted addresses are sent to the ZeroBounce API, and are stored in the `LOGS` KV namespace when that binding exists. Treat that namespace as personal data.
- See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Cloudflare Worker-based email validation with the ZeroBounce Email Validator
The ZeroBounce email validator integrates with Cloudflare Workers to assist with email list cleaning. Through Cloudflare Workers, you can add ZeroBounce's real-time email validation to your forms to prevent bounced emails and spam complaints while improving your email deliverability in real time.
## How Cloudflare Worker’s email validation middleware works
The Cloudflare worker intercepts any incoming POST requests on the route where it’s deployed. In other words, it examines the email address entered into your website form and validates it. The Worker does not reject the request. When the address fails your rules, it rewrites that field to `INVALID` and forwards the request to your origin, which decides what to do with it. A good address is forwarded untouched.

## Cloudflare worker script
https://github.com/zerobounce/zerobounce-cloudflare-worker/blob/main/cloudflare-worker-zerobounce.js

The script is the deployable artifact: paste it into a Worker (Quick Edit) or deploy it with `wrangler`. It uses the
service-worker syntax, so its configuration comes from environment bindings rather than an `env` argument. Cloudflare
says service workers are "deprecated, but still supported". This script does not offer the module syntax.

## Environment bindings

Set these under **Workers & Pages → your Worker → Settings → Variables and Secrets**, or in `wrangler.toml`. Every
binding is optional: when one is missing the Worker falls back to forwarding the request untouched.

| Binding | Type | Default | Purpose |
| --- | --- | --- | --- |
| `API_KEY` | Secret | — | Your ZeroBounce API key. Without it the Worker validates nothing. A key must be printable ASCII (U+0021–U+007E). A key that is empty, or has any character outside that range (whitespace, a control character, an invisible character such as a pasted trailing newline), is refused and logged, and nothing is validated. A missing key is handled the same way: it is logged and the request is forwarded. |
| `API_REGION` | Variable | `global` | Which ZeroBounce host to validate against: `global` or `default`, `us` or `usa`, or `eu`. |
| `API_TIMEOUT` | Variable | `10000` | Milliseconds before the validation request is aborted. Allowed range: 1 to 600000. A value that is empty, not a whole number, zero, negative or above 600000 is logged and replaced by the default. |
| `VALID_STATUS` | Variable (JSON array) | — | Statuses you accept, e.g. `["valid","catch-all"]`. Statuses are compared without regard to case. Anything else is rewritten to `INVALID`. |
| `BYPASS_PATH` | Variable (JSON array) | — | Paths to forward untouched, e.g. `["/wp-login.php"]`. A path must match exactly. |
| `LOGS` | KV namespace | — | When bound, every validation result is written to it. |

Set `VALID_STATUS` and `BYPASS_PATH` as JSON variables. A JSON array of strings is preferred, and it is read first.
Other forms are accepted too:

- A quoted list, such as `['valid', 'catch-all', 'unknown']` or `'/login,' '/logout,'`. This is the form the
  zerobounce.net integration guide shows. Every quoted entry is used.
- A comma-separated list, such as `valid,catch-all`. Commas and whitespace both separate entries.
- A single entry, such as `/wp-login.php`.

Each entry is trimmed. A trailing comma and an empty entry are dropped. Statuses are compared without regard to case.
Paths are compared whole: `/wp-login.php` does not match `/wp-login.php5` or `/blog/wp-login.php`. A value with no
usable entry counts as not set. It is logged once per request and otherwise ignored.

### Validation statuses

The Worker knows the statuses the API returns: `valid`, `invalid`, `catch-all`, `unknown`, `spamtrap`, `abuse` and
`do_not_mail`. It compares them without regard to case or surrounding whitespace. If the API answers 2xx with any other
status, the Worker treats it as a failure and fails open (see below).

### When validation fails

The Worker fails open: if the validation request cannot produce a status (an invalid or drained API key, a timeout, a
network error, a redirect, any non-2xx answer whatever its body says, a status the API does not define, or any other
API error), the submission is forwarded to your origin unvalidated, exactly as if the Worker were not there. Each such
failure is logged with `console.error` (visible in Workers Logs and `wrangler tail`), naming the cause and the API's own
message, so a dead key does not go unnoticed; when `LOGS` is bound, the same failure is stored there instead of
the API's raw answer. The stored value is one JSON text, `{"error": ..., "message": ...}`, not a JSON string inside a
JSON string. The KV key starts with the date and is at most 512 bytes of UTF-8; a longer key is cut without splitting a
character. A missing or refused `API_KEY` is recorded the same way. The API key itself is never logged or stored. The validation request does not follow redirects,
since its URL carries the key.

The Worker logs which address it validated and the result, but never a submitted form body, which can hold passwords.

### Which field is validated

The Worker makes one validation call per request in which it finds an address, so such a request costs one credit.

Field names are matched the way PHP reads them. A name is percent-decoded, `+` is read as a space, leading whitespace is
dropped, and a space or `.` is read as `_`. A field counts as an email field when its name comes out as `email`,
`your-email` or `your_email`. So `your.email`, `your email` and `%20email` count. `?email` does not, because PHP keeps
the `?`.

In a URL-encoded form the Worker validates the email field. If there is no such field, or its value is not an email
address, it validates the first field whose value is an email address.

In a multipart form the Worker first looks at the part named like an email field. A part named like one is read even if
it has a `filename`, because PHP reads it as a text field. If there is none, the Worker takes the first text part whose
whole value is an email address. Any other part with a `filename` is a file part and is never read or changed. A part
with no `filename` is a text field, even when its `Content-Type` is binary, such as `application/octet-stream`. A part
with its own `Content-Type: text/plain` is still a text field. If a part has two `Content-Disposition` headers, the
part counts as an email field when either one names an email field. Only the value bytes are replaced; the whitespace
around them stays.

A multipart `Content-Type` is parsed as a header with parameters. A `boundary=` inside a quoted value is not a
parameter. If the header has more than one `boundary` parameter, the request is ambiguous. The Worker answers it with
`400 Bad Request` (plain text) and does not call your origin. A delimiter line is `--boundary` followed only by spaces
or tabs and a line break; `--boundary-X` is not a delimiter.

A multipart email part with a `Content-Transfer-Encoding` other than `7bit`, `8bit` or `binary` (for example
`quoted-printable` or `base64`) cannot be validated. When `VALID_STATUS` is set, the Worker rewrites its value to
`INVALID`.

The JSON branch is narrow. It applies to a JSON body whose top-level `form` member is a string holding a JSON object,
the shape some form plugins post. Only the keys `email` and `your-email` of that inner object are used, exactly as
spelled. A key such as `email2` is not used. When `VALID_STATUS` is set, an email key whose value is not a string is set
to `"INVALID"`. A plain `{"email": ...}` body has no `form` member, so it is forwarded untouched and not validated.

When a field is repeated, or several email names are present (for example `email` and `your-email`), only the chosen
address is validated. When `VALID_STATUS` is set, every value of those fields that differs from the validated address is
replaced by `INVALID`, whatever the status. When the status is outside `VALID_STATUS`, every value of those fields is
replaced, including the validated one. In the fallback case (no email field, or an `email` field that holds something
that is not an address) the same rule applies to repeats of the chosen field's name. If the validation gives no status
(fail open), or `VALID_STATUS` is not set, the body is not touched.

For URL-encoded and multipart bodies, every other byte reaches your origin exactly as it was sent, including its
percent-encoding and any uploaded files. A rewritten JSON body is different: the Worker serialises it again, so
whitespace, the spelling of numbers and numbers beyond double precision may change.

Known limit: some origins split URL-encoded fields on `;` as well as `&` (Python before 3.9.2). The Worker splits on `&`
only, so such origins are not covered.

Forms are recognised by their media type, in any letter case and with any parameters, so
`application/x-www-form-urlencoded; charset=UTF-8` (what jQuery sends) is validated like
`application/x-www-form-urlencoded`.

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
