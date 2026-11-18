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
The forms in the zerobounce.net integration guide work too, with straight or curly quotes:
`[‘valid’, ‘catch-all’, ‘unknown’]` and `‘/login,’ ‘/logout,’ ‘/connect,’ ‘/signing’`.

If the text is not a JSON array of strings, the Worker ignores every bracket and every quote mark (straight, curly or
angle). It then splits the rest on commas, semicolons, pipes and spaces. So `valid,catch-all`, `valid;catch-all`,
`valid|catch-all`, `[valid, catch-all]` and `valid, 'catch-all'` all give two entries. A single entry, such as
`/wp-login.php`, is one entry. Empty entries are dropped.

Statuses are compared without regard to case. A `VALID_STATUS` entry that is not one of the seven statuses the API
returns (for example `catch_all`) is logged as "Ignoring unknown status" once per request, and is not used. If no entry
is left, `VALID_STATUS` counts as not set, and that is logged too. Paths are compared whole: `/wp-login.php` does not
match `/wp-login.php5` or `/blog/wp-login.php`. A `BYPASS_PATH` with no usable entry counts as not set. It is logged
once per request and otherwise ignored.

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
JSON string. The KV key is built from the date, the address and the path (it starts with `{` and the date). It is at
most 512 bytes of UTF-8; a longer key is cut without splitting a character. A missing or refused `API_KEY` is recorded
the same way. The API key itself is never logged or stored. The validation request does not follow redirects, since its
URL carries the key.

The Worker logs which address it validated and the result, but never a submitted form body, which can hold passwords.

### Which field is validated

The Worker makes at most one validation call per request, so a request costs at most one credit. A call that
fails gives no result and is not counted.

**Email fields.** An email field is any field whose name contains `email`, in any letter case: `email`, `your-email`,
`Email2`, `billing_email_address`. For a URL-encoded form the name is read both as sent and after percent-decoding
(`+` read as a space). In a multipart form it is a part whose headers mention `email`. In the JSON branch it is a key
that contains `email`. The Worker does not try to copy the way an origin parses field names. Odd spellings such as
`your.email` or `email[]` are covered because they still contain `email`.

**Which address is validated.** The value of an email field counts as an address when it is a whole email address
(at most 320 characters, surrounding whitespace ignored). The Worker picks one address:

1. The first email field named exactly `email`, `your-email` or `your_email` whose value is an address.
2. Otherwise the first email field whose value is an address.
3. Otherwise, as a fallback, the first field whose value is an address, whatever its name.

A value that is not an address is never sent to ZeroBounce.

**What is rewritten.** This only happens when `VALID_STATUS` is set.

- If the status is outside `VALID_STATUS`, every email field that holds an address becomes `INVALID`, and so does the
  chosen field.
- If the status is accepted, every email field that holds a different address becomes `INVALID`. Addresses are
  compared without regard to case and surrounding whitespace.
- In the fallback case the same rule applies to email fields. Repeats of the chosen field's name are handled as
  before: a repeated value that differs from the validated one becomes `INVALID`.
- If the validation gives no status (fail open), or `VALID_STATUS` is not set, the body is not touched.

So your origin never receives an unvalidated address in an email field. The trade-off: a form that has a second,
different address field on purpose (a friend's email, a CC) gets that field rewritten to `INVALID`. Such a form should
use `BYPASS_PATH`, or name that field without the word `email`.

**Multipart forms.** A part is an email field when its header block (all header lines, folded lines included) mentions
`email`, whatever the `Content-Disposition` looks like. If there is no such part, the Worker takes the first text part
whose whole value is an address. A file part (a part with a non-empty `filename`) is not read, unless its headers
mention `email`. Then it is treated like any email field, and rewritten only if its value is an address. A part with no
`filename` is a text field, even when its `Content-Type` is binary. Only the value bytes are replaced; the whitespace
around them stays.

A multipart email part with a `Content-Transfer-Encoding` other than `7bit`, `8bit` or `binary` (for example
`quoted-printable` or `base64`) cannot be validated. When `VALID_STATUS` is set, the Worker rewrites its value to
`INVALID`.

If the `Content-Type` header contains the word `boundary` more than once, in any form (inside quotes, as `xboundary`,
as `boundary*`), the request is ambiguous. The boundary value itself does not count, so a browser boundary such as
`----WebKitFormBoundaryAbc123` is fine. The Worker answers it with `400 Bad Request` (plain text) and does not call
your origin. A delimiter line is `--boundary` followed only by spaces or tabs and a line break; `--boundary-X` is not a
delimiter.

**JSON branch.** It applies to a JSON body whose top-level `form` member is a string holding a JSON object, the shape
some form plugins post. Every key of that inner object that contains `email` is an email field, as above. A key such
as `email_password` whose value is not an address is never sent anywhere. When `VALID_STATUS` is set, an email key whose
value is not a string is set to `"INVALID"`. A rewritten body is serialised again. A plain `{"email": ...}` body has no
`form` member, so it is forwarded untouched and not validated. (Earlier versions read any key that starts with `email`.
This version reads any key that contains it.)

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
