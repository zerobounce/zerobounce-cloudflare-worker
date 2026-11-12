/**
 * Worker Name:       ZeroBounce Email Validator
 * Worker URI:        tbc
 * Description:       Cloudflare ZeroBounce Email Validation Worker
 * Version:           1.0.0
 * Author:            ZeroBounce
 * Author URI:        https://www.zerobounce.net/
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 */

/**
 * Community based email Regex heavily modified to our needs
 * DO NOT EDIT!
 * ------------
 - allows Latin characters ("a" - "z" or "A" - "Z") within the email address.
 - permits digits (0 - 9) in the email address.
 - enforces domain part restrictions.
 - allows hyphens (-) inside the domain as long as they don't lead or trail the domain.
 - allows IP address literals surrounded with square brackets ([]) for the domain names.
 - restricts sub-domains to a maximum length of 63 characters.
 - applies local part restrictions.
 - permits the set of special characters allowed by RFC 5322 ("!", "#", "$", "%", "&", "'", "*", "+", "-", "/", "=", "?", "^", "_", "`", "{", "|", "}", "~”) to reside in the local part.
 - lets local part comprise as double quotes housing one or more sequences of ASCII characters.
 - doesn't allow trailing, leading, or consecutive periods anywhere within the email address.
 - doesn't allow Unicode characters.
 - doesn't check for the entire length of the email address to be less than or equal to 253 characters.
 - ignores obsolete syntax-related rules.
 */
const regex1 = '(\\"\\s+|[\\\\r\\\\n]+)(([-!#-\'*+\\/-9=?A-Z^-~]+(\\.[-!#-\'*+\\/-9=?A-Z^-~]+)*|"([]!#-[^-~ \\t]|(\\\\[\\t -~]))+")@([0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?(\\.[0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?)*|\\[((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|IPv6:((((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){6}|::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){5}|[0-9A-Fa-f]{0,4}::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){4}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):)?(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){3}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,2}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){2}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,3}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,4}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,5}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,6}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)|(?!IPv6:)[0-9A-Za-z-]*[0-9A-Za-z]:[!-Z^-~]+)]))';
const regexBodyBuffer = new RegExp(`${regex1}`, '');

/**
 * Similar to the above.
 * DO NOT EDIT!
 * ------------
 */
const regex2 = '(.*=)(([-!#-\'*+\\/-9=?A-Z^-~]+(\\.[-!#-\'*+\\/-9=?A-Z^-~]+)*|"([]!#-[^-~ \\t]|(\\\\[\\t -~]))+")@([0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?(\\.[0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?)*|\\[((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|IPv6:((((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){6}|::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){5}|[0-9A-Fa-f]{0,4}::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){4}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):)?(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){3}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,2}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){2}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,3}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,4}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,5}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,6}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)|(?!IPv6:)[0-9A-Za-z-]*[0-9A-Za-z]:[!-Z^-~]+)]))&';
const regexFormBuffer = new RegExp(`${regex2}`, '');

/**
 * The address pattern of regex2 on its own, anchored, to test one decoded form
 * value: regex2 is "(.*=)" + "(address)" + "&", and only the middle is kept.
 */
const regexFormValue = new RegExp(`^${regex2.slice('(.*=)'.length, -'&'.length)}$`, '');

/**
 * Similar to the above.
 * DO NOT EDIT!
 * ------------
 */
const regex3 = '(\\\\\\"([-!#-\'*+\\/-9=?A-Z^-~]+(\\.[-!#-\'*+\\/-9=?A-Z^-~]+)*|"([]!#-[^-~ \\t]|(\\\\[\\t -~]))+")@([0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?(\\.[0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?)*|\\[((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|IPv6:((((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){6}|::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){5}|[0-9A-Fa-f]{0,4}::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){4}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):)?(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){3}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,2}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){2}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,3}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,4}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,5}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,6}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)|(?!IPv6:)[0-9A-Za-z-]*[0-9A-Za-z]:[!-Z^-~]+)])\\\\\\")';
const regexJsonBuffer = new RegExp(`${regex3}`, '');

/**
 * The TextEncoder takes a stream of code points as input and emits a stream of bytes.
 * Encoding types passed to the constructor are ignored and a UTF-8 TextEncoder is created.
 * Encodes a string input.
 */
function textToBuffer(text) {
    const encoder = new TextEncoder();
    return encoder.encode(text);
}

/**
 * The TextDecoder interface represents a UTF-8 decoder.
 * Decoders take a stream of bytes as input and emit a stream of code points.
 * Decodes using the method specified in the TextDecoder object.
 */
function bufferToText(buffer) {
    const decoder = new TextDecoder();
    return decoder.decode(buffer);
}

/**
 * Splits a URL-encoded body into its fields without decoding the body as a
 * whole. Each field records its decoded name and value (decoded the way a
 * browser or origin does, so malformed percent-encoding never throws) and the
 * byte offsets of its raw value, so a value can be replaced while every other
 * byte of the body reaches the origin exactly as it was sent.
 */
function formFields(bytes) {
    const fields = [];
    let start = 0;

    while (start < bytes.length) {
        let end = bytes.indexOf(0x26, start); // '&'
        if (end === -1) {
            end = bytes.length;
        }

        if (end > start) {
            const raw = bytes.subarray(start, end);
            const equals = raw.indexOf(0x3d); // '='
            const [[name, value]] = new URLSearchParams(bufferToText(raw));

            fields.push({ name, value, valueStart: equals === -1 ? end : start + equals + 1, end });
        }

        start = end + 1;
    }

    return fields;
}

/** Returns a copy of the body with the raw value of each given field replaced. */
function replaceFieldValues(bytes, fields, replacement) {
    const marker = textToBuffer(replacement);
    const parts = [];
    let position = 0;

    for (const field of fields) {
        parts.push(bytes.subarray(position, field.valueStart), marker);
        position = field.end;
    }
    parts.push(bytes.subarray(position));

    const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        body.set(part, offset);
        offset += part.length;
    }

    return body;
}

/**
 * The media type of a Content-Type header in lower case, without its
 * parameters: "Application/X-WWW-Form-URLEncoded; charset=UTF-8" becomes
 * "application/x-www-form-urlencoded".
 */
function mediaType(contentType) {
    return String(contentType).split(';')[0].trim().toLowerCase();
}

/** The boundary parameter of a multipart Content-Type header, or null. */
function multipartBoundary(contentType) {
    const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType));
    return match ? (match[1] || match[2]) : null;
}

/** The index of the first occurrence of `pattern` in `bytes` at or after `from`, or -1. */
function indexOfBytes(bytes, pattern, from = 0, to = bytes.length) {
    for (let i = bytes.indexOf(pattern[0], from); i !== -1 && i + pattern.length <= to; i = bytes.indexOf(pattern[0], i + 1)) {
        let j = 1;
        while (j < pattern.length && bytes[i + j] === pattern[j]) {
            j++;
        }
        if (j === pattern.length) {
            return i;
        }
    }
    return -1;
}

/**
 * One character per byte, so an index in the string is the same index in the
 * bytes. Used only to run the address regex over a form field; the result is
 * never encoded back into the body.
 */
function bytesToBinaryString(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x2000) {
        text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
    }
    return text;
}

/**
 * Finds the first address in the non-file parts of a multipart body, without
 * decoding the body as text. Returns the address and the byte offsets of the
 * text regexBodyBuffer matched (the span its "$1INVALID" replacement changes),
 * or null. File parts are skipped: their bytes, binary or not, are never read
 * as an address and never rewritten.
 */
function multipartAddress(bytes, boundary) {
    const LF = 0x0a;
    const CR = 0x0d;
    // Delimiters are "--boundary" at the start of a line; CRLF is the standard
    // line break, and a bare LF is accepted as well.
    const delimiter = textToBuffer(`\n--${boundary}`);
    let next = indexOfBytes(bytes, delimiter.subarray(1)) === 0 ? 0 : indexOfBytes(bytes, delimiter);
    let after = next === 0 ? delimiter.length - 1 : next + delimiter.length;

    while (next !== -1) {
        // The closing delimiter ends with "--".
        if (bytes[after] === 0x2d && bytes[after + 1] === 0x2d) {
            break;
        }
        const lineEnd = bytes.indexOf(LF, after);
        if (lineEnd === -1) {
            break;
        }
        const start = lineEnd + 1;
        next = indexOfBytes(bytes, delimiter, start);
        if (next === -1) {
            break;
        }
        const end = next > start && bytes[next - 1] === CR ? next - 1 : next;
        after = next + delimiter.length;

        const blank = [indexOfBytes(bytes, textToBuffer('\n\r\n'), start, end), indexOfBytes(bytes, textToBuffer('\n\n'), start, end)]
            .filter((i) => i !== -1);
        const headers = bufferToText(bytes.subarray(start, blank.length ? Math.min(...blank) : end));
        if (/;\s*filename\*?\s*=/i.test(headers)) {
            continue;
        }

        const m = regexBodyBuffer.exec(bytesToBinaryString(bytes.subarray(start, end)));
        if (m !== null) {
            const valueStart = start + m.index + m[1].length;
            return { email: m[2], valueStart, end: valueStart + m[2].length };
        }
    }

    return null;
}

/**
 * Logs validations into the Worker KV Namespace
 */
function logValidation(event, email, url, result) {
    if (typeof LOGS !== 'undefined') {
        const pad = (n, s = 2) => (`${new Array(s).fill(0)}${n}`).slice(-s);
        const d = new Date();

        // The waitUntil function allows us to continue performing work in our Cloudflare Worker, without blocking.
        // Every string is redacted before it is stored, so the API key never reaches KV.
        event.waitUntil(LOGS.put(`{${pad(d.getFullYear(),4)}-${pad(d.getMonth()+1)}-${pad(d.getDate())}}-{${email}}-{${url}}-{${pad(d.getHours())}:${pad(d.getMinutes())}}-${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`,
            JSON.stringify(result, (key, value) => (typeof value === 'string' ? redactKey(value) : value))));
    }
}

/**
 * ZeroBounce serves the real-time validation API from three interchangeable
 * hosts: `api` is the global entry point, while `api-us` and `api-eu` pin
 * traffic to a single region, which some deployments need for data residency.
 *
 * The region is selected with the optional `API_REGION` environment binding
 * (Workers -> Settings -> Variables and Secrets). When the binding is absent
 * or empty the Worker keeps calling the global host, so Workers deployed
 * before this setting existed behave exactly as they did before.
 *
 *   API_REGION unset / "global"  ->  https://api.zerobounce.net/v2/validate
 *   API_REGION = "us"            ->  https://api-us.zerobounce.net/v2/validate
 *   API_REGION = "eu"            ->  https://api-eu.zerobounce.net/v2/validate
 *
 * ZeroBounce documents no regional bulk or warm-up host, so this applies to
 * the single-email /validate endpoint only.
 */
const DEFAULT_VALIDATE_URL = 'https://api.zerobounce.net/v2/validate';
const US_VALIDATE_URL = 'https://api-us.zerobounce.net/v2/validate';
const EU_VALIDATE_URL = 'https://api-eu.zerobounce.net/v2/validate';

const VALIDATE_URL_BY_REGION = {
    '': DEFAULT_VALIDATE_URL,
    'global': DEFAULT_VALIDATE_URL,
    'default': DEFAULT_VALIDATE_URL,
    'us': US_VALIDATE_URL,
    'usa': US_VALIDATE_URL,
    'eu': EU_VALIDATE_URL
};

/**
 * Resolves the validation endpoint from the optional API_REGION binding.
 * The value is matched against a fixed allow-list (with hasOwnProperty, so
 * inherited names such as "constructor" are not treated as regions): an
 * unrecognised region falls back to the global host rather than sending the
 * API key to somewhere unintended.
 */
function validationEndpoint() {
    if (typeof API_REGION === 'undefined' || API_REGION === null) {
        return DEFAULT_VALIDATE_URL;
    }

    const region = String(API_REGION).trim().toLowerCase();

    if (Object.prototype.hasOwnProperty.call(VALIDATE_URL_BY_REGION, region)) {
        return VALIDATE_URL_BY_REGION[region];
    }

    console.log(`Unknown API_REGION: ${API_REGION}. Falling back to ${DEFAULT_VALIDATE_URL}.`);

    return DEFAULT_VALIDATE_URL;
}

/**
 * Milliseconds before the validation request is aborted when the optional
 * API_TIMEOUT binding is not set, or is not a positive number.
 */
const DEFAULT_API_TIMEOUT_MS = 10000;

function apiTimeout() {
    if (typeof API_TIMEOUT === 'undefined' || API_TIMEOUT === null || API_TIMEOUT === '') {
        return DEFAULT_API_TIMEOUT_MS;
    }

    const timeout = Number(API_TIMEOUT);

    if (Number.isFinite(timeout) && timeout > 0) {
        return timeout;
    }

    console.log(`Invalid API_TIMEOUT: ${API_TIMEOUT}. Using ${DEFAULT_API_TIMEOUT_MS} ms.`);

    return DEFAULT_API_TIMEOUT_MS;
}

/** Removes the API key from text that is about to be logged or stored. */
function redactKey(text) {
    const value = String(text);
    if (typeof API_KEY === 'undefined' || !API_KEY) {
        return value;
    }
    const key = String(API_KEY);
    // Raw, URL-encoded, and JSON-escaped (with and without "/" escaped as
    // "\/"), as a body quoting a JSON copy of the key would carry it. Longest
    // first, so no form leaves part of a longer one behind.
    const json = JSON.stringify(key).slice(1, -1);
    const forms = [...new Set([key, encodeURIComponent(key), json, json.replace(/\//g, '\\/')])]
        .sort((a, b) => b.length - a.length);
    return forms.reduce((text, form) => text.split(form).join('***'), value);
}

/**
 * A failed validation, as the JSON text this function has always returned for
 * one. Built with JSON.stringify so quotes in a message keep it valid JSON.
 *
 * Every failure is logged as an error: the Worker fails open (the submission
 * is forwarded unvalidated, as the README documents), but never silently.
 */
function validationFailure(name, message) {
    const safeMessage = redactKey(message);
    console.error(`ZeroBounce validation failed (${name}): ${safeMessage}. The submission is forwarded unvalidated.`);
    return JSON.stringify({ error: name, message: safeMessage });
}

/**
 * The API's own error text when a body carries no validation result. LIVE: an
 * invalid or drained key gets an HTTP 200 with {"error": "..."} and no status.
 */
function apiErrorText(data, fallback = 'ZeroBounce returned no validation status.') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return 'ZeroBounce returned an unexpected response.';
    }
    for (const key of ['error', 'error_message', 'Error', 'message', 'Message', 'detail']) {
        if (typeof data[key] === 'string' && data[key].trim()) {
            return data[key].trim();
        }
    }
    return fallback;
}

/**
 * Whether a 2xx body is an API error even though it carries a status: a
 * success of false (also as the string "false" or "False"), or a non-empty
 * error, error_message or Error string. A validation result has neither.
 */
function isApiErrorBody(data) {
    if (data.success === false || data.success === 'false' || data.success === 'False') {
        return true;
    }
    return ['error', 'error_message', 'Error'].some(
        (key) => typeof data[key] === 'string' && data[key].trim() !== ''
    );
}

/**
 * Validates an email using the ZeroBounce real-time email validation API
 * The fetch request can be aborted automatically using a timeout.
 * The function is async however it waits itself for the response.
 */
async function validateEmail(email, ip_address) {
    if (typeof API_KEY !== 'undefined') {
        // A pasted key often carries a trailing newline or space, which would
        // be sent as %0A or %20 and fail on every request. Refuse it, without
        // logging the key itself.
        if (!/^[^\s\u0000-\u001f\u007f]+$/.test(String(API_KEY))) {
            return validationFailure('Invalid API_KEY', 'API_KEY is empty or contains whitespace or control characters; check the secret');
        }

        const url = new URL(validationEndpoint());

        url.searchParams.set("api_key", API_KEY);
        url.searchParams.set("email", email);
        // Optional: leave it out rather than send the string "null".
        if (ip_address) {
            url.searchParams.set("ip_address", ip_address);
        }

        try {
            const resp = await fetch(url, {
                signal: AbortSignal.timeout(apiTimeout()),
                // The URL carries the API key: never follow a redirect with it.
                redirect: 'manual',
                headers: {
                    'User-Agent': 'ZeroBounce Email Validator (Cloudflare Worker)'
                }
            });

            if (resp.status >= 300 && resp.status < 400) {
                return validationFailure('Redirect', `ZeroBounce answered with a redirect (HTTP ${resp.status}), which this Worker does not follow`);
            }

            if (resp.status < 200 || resp.status >= 300) {
                // Any other non-2xx answer is an API error, whatever its body
                // says: a 500 {"status":"error"} or a 429 {"status":429} is not
                // a validation result and must not reject the address.
                const fallback = `ZeroBounce answered with HTTP ${resp.status}`;
                let body = null;
                try {
                    body = JSON.parse(await resp.text());
                } catch (err) {
                    // Not JSON (an HTML error page, plain text, or an empty body).
                }
                return validationFailure(`HTTP ${resp.status}`, body && typeof body === 'object' ? apiErrorText(body, fallback) : fallback);
            }

            const data = await resp.json();

            if (
                !data ||
                typeof data !== 'object' ||
                !Object.prototype.hasOwnProperty.call(data, 'status') ||
                isApiErrorBody(data)
            ) {
                // A dead or invalid key, or another API error, on a 2xx status,
                // even one that also carries a status: it is not a validation
                // result, so the address is not rewritten (fail open).
                // The redacted failure is returned (and stored in KV), never the
                // raw body, which can quote the request URL and so the key.
                return validationFailure(`HTTP ${resp.status}`, apiErrorText(data));
            }

            return data;
        } catch (err) {
            // A network error, a timeout, a body that is not JSON, or some other problem.
            return validationFailure(err && err.name ? err.name : 'Error', err && err.message ? err.message : String(err));
        }
    }
}

/**
 * The handler function for the event listener.
 */
async function handleRequest(event) {
    // An error here will return the origin response, as if the Worker wasn’t present.
    const request = event.request;

    if (request.method === 'POST') {
        console.log(`Incoming correct request: ${request.method}`);

        const {
            headers
        } = request;
        const contentType = headers.get('content-type');
        const {
            pathname
        } = new URL(request.url);
        const clientIP = headers.get('CF-Connecting-IP');

        if (typeof BYPASS_PATH !== 'undefined') {
            if (BYPASS_PATH.includes(pathname)) {
                console.log(`BYPASS_PATH set for: ${pathname}. Returning original request.`);
                return await fetch(request);
            }
        }

        if (contentType) {
            console.log(`Incoming content type: ${contentType}`);

            if (mediaType(contentType) === 'multipart/form-data') {
                // The body is searched part by part and never decoded or
                // re-encoded as a whole: file parts reach the origin byte for
                // byte, and a rejected address is replaced in place.
                const _body = new Uint8Array(await request.clone().arrayBuffer());
                const boundary = multipartBoundary(contentType);
                const match = boundary ? multipartAddress(_body, boundary) : null;

                if (match !== null) {
                    const email = match.email;
                    console.log(`Matched email: ${email}`);

                    let validate = await validateEmail(email, clientIP);

                    await logValidation(event, email, pathname, validate);

                    if (validate.hasOwnProperty('status')) {
                        console.log(`Email validation status: ${validate.status}`);

                        if (typeof VALID_STATUS !== 'undefined' && !VALID_STATUS.includes(validate.status)) {
                            const newRequestInit = {
                                // Change body
                                body: replaceFieldValues(_body, [match], 'INVALID'),
                            };

                            const newRequest = new Request(
                                request.url.toString(),
                                new Request(request, newRequestInit)
                            );

                            console.log(`Returning modified request.`);

                            return await fetch(newRequest);
                        }
                    }
                } else {
                    // Never log the body itself: it can hold passwords and other form fields.
                    console.log(`Unable to find an email match in a multipart body of ${_body.byteLength} bytes.`);
                }

                // Return original request untouched
                return await fetch(request);
            } else if (mediaType(contentType) === 'application/x-www-form-urlencoded') {
                // The body is split into fields but never decoded or
                // re-encoded as a whole: every field reaches the origin
                // exactly as it was sent, and a rejected address is replaced
                // in place.
                const _body = new Uint8Array(await request.clone().arrayBuffer());
                const fields = formFields(_body);

                // Method 1:
                // Try and extract the email from "normal inputs"
                // ==========================================================
                let field = fields.find((f) => f.name === 'email');
                if (!field || !field.value) {
                    field = fields.find((f) => f.name === 'your-email');
                }

                if (field && field.value) {
                    console.log(`Found email input: ${field.value}`);
                }
                // Method 2:
                // Find the first field whose value is an email address
                // This applies when the email input is not named accordingly (email)
                // ==========================================================
                else {
                    field = fields.find((f) => regexFormValue.test(f.value));

                    if (field) {
                        console.log(`Matched email: ${field.value}`);
                    } else {
                        // Never log the body itself: it can hold passwords and other form fields.
                        console.log(`Unable to find an email match in a form body of ${_body.byteLength} bytes.`);
                    }
                }

                if (field) {
                    const email = field.value;

                    let validate = await validateEmail(email, clientIP);

                    await logValidation(event, email, pathname, validate);

                    if (validate.hasOwnProperty('status')) {
                        console.log(`Email validation status: ${validate.status}`);

                        if (typeof VALID_STATUS !== 'undefined' && !VALID_STATUS.includes(validate.status)) {
                            // Rewrite the field that held the address, and any
                            // repeat of it, so the rejected address never
                            // reaches the origin.
                            const rejected = fields.filter((f) => f.name === field.name && f.value);

                            const newRequestInit = {
                                // The incoming Content-Type header is carried
                                // over to the new request, so the body stays
                                // URL-encoded.
                                body: replaceFieldValues(_body, rejected, 'INVALID'),
                            };

                            const newRequest = new Request(
                                request.url.toString(),
                                new Request(request, newRequestInit)
                            );

                            console.log(`Returning modified request.`);

                            return await fetch(newRequest);
                        }
                    }
                }

                // Return original request untouched
                console.log(`Returning original request, nothing done.`);
                return await fetch(request);
            }
            // Experimental
            else if (mediaType(contentType) === 'application/json') {
                const _body = await request.clone().json();

                if (_body.hasOwnProperty('form')) {
                    let _form = JSON.parse(_body.form);

                    const email_key = Object.keys(_form).filter(k => k.startsWith('email'));

                    if (email_key) {
                        const email = _form[email_key];

                        if (email) {
                            console.log(`Matched email: ${email}`);

                            let validate = await validateEmail(email, clientIP);

                            await logValidation(event, email, pathname, validate);

                            if (validate.hasOwnProperty('status')) {
                                console.log(`Email validation status: ${validate.status}`);

                                if (typeof VALID_STATUS !== 'undefined' && !VALID_STATUS.includes(validate.status)) {
                                    _form[email_key] = "INVALID";

                                    _body.form = JSON.stringify(_form);

                                    const newRequestInit = {
                                        // Change body
                                        body: JSON.stringify(_body),
                                    };

                                    const newRequest = new Request(
                                        request.url.toString(),
                                        new Request(request, newRequestInit)
                                    );

                                    console.log(`Returning modified request.`);

                                    return await fetch(newRequest);
                                }
                            }
                        }
                    } else {
                        console.log(`Unable to find an email match in a JSON body with ${Object.keys(_form).length} form fields.`);
                    }
                }

                // Return original request untouched
                return await fetch(request);
            }
        }
    }

    return await fetch(request);
}

addEventListener("fetch", (event) => {
    // By using event.passThroughOnException, a Workers application will forward requests to your origin if an exception is thrown during the Worker’s execution.     // This allows you to add logging, tracking, or other features with Workers, without degrading your application’s functionality.
    event.passThroughOnException();
    event.respondWith(handleRequest(event));
});
