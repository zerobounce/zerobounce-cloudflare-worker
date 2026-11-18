/**
 * Worker Name:       ZeroBounce Email Validator
 * Worker URI:        https://github.com/zerobounce/zerobounce-cloudflare-worker
 * Description:       Cloudflare ZeroBounce Email Validation Worker
 * Version:           1.0.0
 * Author:            ZeroBounce
 * Author URI:        https://www.zerobounce.net/
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 */

/**
 * Community based email regex, heavily modified to our needs. It is applied only
 * to one decoded, trimmed form value at a time (see regexFormValue), never to a
 * whole body.
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

/**
 * Similar to the above.
 * DO NOT EDIT!
 * ------------
 */
const regex2 = '(.*=)(([-!#-\'*+\\/-9=?A-Z^-~]+(\\.[-!#-\'*+\\/-9=?A-Z^-~]+)*|"([]!#-[^-~ \\t]|(\\\\[\\t -~]))+")@([0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?(\\.[0-9A-Za-z]([0-9A-Za-z-]{0,61}[0-9A-Za-z])?)*|\\[((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|IPv6:((((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){6}|::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){5}|[0-9A-Fa-f]{0,4}::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){4}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):)?(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){3}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,2}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){2}|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,3}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,4}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,5}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3})|(((0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}):){0,6}(0|[1-9A-Fa-f][0-9A-Fa-f]{0,3}))?::)|(?!IPv6:)[0-9A-Za-z-]*[0-9A-Za-z]:[!-Z^-~]+)]))&';

/**
 * The address pattern of regex2 on its own, anchored, to test one decoded form
 * value: regex2 is "(.*=)" + "(address)" + "&", and only the middle is kept.
 */
const regexFormValue = new RegExp(`^${regex2.slice('(.*=)'.length, -'&'.length)}$`, '');


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
 * Logging goes through redactKey, so a line never carries the API key, whatever
 * text (a form value, a header, a binding) it was built from.
 */
function logLine(message) {
    console.log(redactKey(message));
}

function errorLine(message) {
    console.error(redactKey(message));
}

/**
 * Splits a URL-encoded body into its fields without decoding the body as a
 * whole. Each field records its decoded name and value (decoded the way a
 * browser or origin does, so malformed percent-encoding never throws) and the
 * byte offsets of its raw value, so a value can be replaced while every other
 * byte of the body reaches the origin exactly as it was sent.
 *
 * The name is read from the raw bytes: a leading "?" is part of the name
 * ("?email" is not "email"), which URLSearchParams would otherwise strip from
 * the start of a string.
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
            // The leading "&" keeps URLSearchParams from dropping a "?" in the name.
            const [[name, value]] = new URLSearchParams(`&${bufferToText(raw)}`);

            fields.push({ name, value, valueStart: equals === -1 ? end : start + equals + 1, end });
        }

        start = end + 1;
    }

    return fields;
}

/**
 * Returns a copy of the body with the byte span (valueStart to end) of each
 * given field replaced. The fields must not overlap.
 */
function replaceFieldValues(bytes, fields, replacement) {
    const marker = textToBuffer(replacement);
    const parts = [];
    let position = 0;

    for (const field of [...fields].sort((a, b) => a.valueStart - b.valueStart)) {
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
 * The parameters of a Content-Disposition header value as {name: value} (names
 * in lower case): a linear scan that honours quoted strings, so a filename
 * that merely contains `name="email"` does not set the field name.
 */
function headerParameters(text) {
    const params = {};
    let i = text.indexOf(';');
    while (i !== -1 && i < text.length) {
        i += 1; // past ';'
        while (i < text.length && /[ \t]/.test(text[i])) i++;
        const nameStart = i;
        while (i < text.length && text[i] !== '=' && text[i] !== ';') i++;
        const paramName = text.slice(nameStart, i).trim().toLowerCase();
        let value = '';
        if (text[i] === '=') {
            i += 1;
            while (i < text.length && /[ \t]/.test(text[i])) i++;
            if (text[i] === '"') {
                i += 1;
                while (i < text.length && text[i] !== '"') {
                    if (text[i] === '\\' && i + 1 < text.length) i++;
                    value += text[i];
                    i++;
                }
                i += 1; // past the closing quote
                while (i < text.length && text[i] !== ';') i++;
            } else {
                const valueStart = i;
                while (i < text.length && text[i] !== ';') i++;
                value = text.slice(valueStart, i).trim();
            }
        }
        if (paramName && !Object.prototype.hasOwnProperty.call(params, paramName)) {
            params[paramName] = value;
        }
    }
    return params;
}

/** Whether the byte is a space, tab, CR or LF. */
function isAsciiSpace(byte) {
    return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

/**
 * The text fields of a multipart body, without decoding the body as text. Each
 * is {name, value, valueStart, end}: the decoded field name, the value with
 * surrounding space, tab, CR and LF removed, and the byte span of that value
 * (so a replacement keeps the whitespace around it). A part is found by its
 * delimiter line and read header by header up to the first blank line (CRLF or
 * bare LF); a part with a filename (or a filename*) is a file and is skipped:
 * its bytes, binary or not, are never read as an address and never rewritten.
 * No regular expression runs over body bytes here, so the cost is linear.
 */
function multipartFields(bytes, boundary) {
    const LF = 0x0a;
    const CR = 0x0d;
    const dashes = textToBuffer(`--${boundary}`);
    // A delimiter is "--boundary" at the start of a line, followed by space,
    // tab, a line break or "--"; CRLF is the standard break and a bare LF is
    // accepted as well.
    const delimiterAt = (index) => {
        const after = bytes[index + dashes.length];
        return after === undefined || after === CR || after === LF || after === 0x20 || after === 0x09 || after === 0x2d;
    };
    const lineStart = textToBuffer(`\n--${boundary}`);
    const nextDelimiter = (from) => {
        for (let i = indexOfBytes(bytes, lineStart, from); i !== -1; i = indexOfBytes(bytes, lineStart, i + 1)) {
            if (delimiterAt(i + 1)) {
                return i + 1;
            }
        }
        return -1;
    };

    let delimiter = indexOfBytes(bytes, dashes, 0, dashes.length) === 0 && delimiterAt(0) ? 0 : nextDelimiter(0);
    const fields = [];

    while (delimiter !== -1) {
        const after = delimiter + dashes.length;
        // The closing delimiter ends with "--".
        if (bytes[after] === 0x2d && bytes[after + 1] === 0x2d) {
            break;
        }
        const lineEnd = bytes.indexOf(LF, after);
        if (lineEnd === -1) {
            break;
        }
        const start = lineEnd + 1;
        const following = nextDelimiter(lineEnd);
        if (following === -1) {
            break;
        }
        // The line break before the delimiter belongs to the delimiter.
        const next = following - 1;
        const end = Math.max(start, next > start && bytes[next - 1] === CR ? next - 1 : next);
        delimiter = following;

        // Headers, up to the first blank line.
        let position = start;
        let bodyStart = -1;
        let disposition = null;
        while (position < end) {
            const lf = bytes.indexOf(LF, position);
            if (lf === -1 || lf >= end) {
                break;
            }
            const lineStop = lf > position && bytes[lf - 1] === CR ? lf - 1 : lf;
            if (lineStop === position) {
                bodyStart = lf + 1;
                break;
            }
            const line = bufferToText(bytes.subarray(position, lineStop));
            const colon = line.indexOf(':');
            if (colon !== -1 && disposition === null && line.slice(0, colon).trim().toLowerCase() === 'content-disposition') {
                disposition = line.slice(colon + 1);
            }
            position = lf + 1;
        }
        if (bodyStart === -1 || disposition === null) {
            continue;
        }

        const params = headerParameters(disposition);
        if (Object.prototype.hasOwnProperty.call(params, 'filename') || Object.prototype.hasOwnProperty.call(params, 'filename*')) {
            continue;
        }

        let valueStart = bodyStart;
        let valueEnd = Math.max(bodyStart, end);
        while (valueStart < valueEnd && isAsciiSpace(bytes[valueStart])) valueStart++;
        while (valueEnd > valueStart && isAsciiSpace(bytes[valueEnd - 1])) valueEnd--;
        fields.push({
            name: Object.prototype.hasOwnProperty.call(params, 'name') ? params.name : '',
            value: bufferToText(bytes.subarray(valueStart, valueEnd)),
            valueStart,
            end: valueEnd,
        });
    }

    return fields;
}

/** The field names the Worker reads first, in order. */
const EMAIL_FIELD_NAMES = ['email', 'your-email'];

/** An address longer than this cannot be one (RFC 5321 allows 254). */
const MAX_ADDRESS_LENGTH = 320;

/** Whether the whole value, trimmed, is one address. Runs on at most 320 characters. */
function isAddress(value) {
    const text = String(value).trim();
    return text.length > 0 && text.length <= MAX_ADDRESS_LENGTH && regexFormValue.test(text);
}

/**
 * Picks the address to validate among the fields of a form: the first field
 * named `email` whose value is an address, then the same for `your-email`;
 * when no such field holds one, the first field whose whole value is an
 * address. Returns {field, named} or null.
 */
function chooseAddressField(fields) {
    for (const name of EMAIL_FIELD_NAMES) {
        const field = fields.find((f) => f.name === name && isAddress(f.value));
        if (field) {
            return { field, named: true };
        }
    }
    const field = fields.find((f) => isAddress(f.value));
    return field ? { field, named: false } : null;
}

/**
 * The fields to rewrite once the chosen address is validated. Only one address
 * costs a validation credit, so any other value of a candidate field (every
 * repeat, and the other of `email` / `your-email`) would reach the origin
 * unvalidated: it is rewritten too when it differs from the validated address,
 * whatever the status. A rejected address rewrites every candidate value. The
 * candidates are the two named fields, or, when the address was found in a
 * field with another name, every field of that name. Empty values stay.
 */
function fieldsToRewrite(fields, chosen, rejected) {
    const address = chosen.field.value.trim();
    return fields.filter((f) => (
        (chosen.named ? EMAIL_FIELD_NAMES.includes(f.name) : f.name === chosen.field.name) &&
        f.value.trim() !== '' &&
        (rejected || f.value.trim() !== address)
    ));
}

/** Workers KV keys are at most 512 bytes of UTF-8. */
const KV_KEY_MAX_BYTES = 512;

/** The text cut to at most `maxBytes` of UTF-8 without splitting a code point. */
function truncateUtf8(text, maxBytes) {
    const encoder = new TextEncoder();
    let bytes = 0;
    let out = '';
    for (const char of text) {
        const size = encoder.encode(char).length;
        if (bytes + size > maxBytes) {
            break;
        }
        bytes += size;
        out += char;
    }
    return out;
}

/**
 * Logs validations into the Worker KV Namespace
 */
function logValidation(event, email, url, result) {
    if (typeof LOGS !== 'undefined') {
        const pad = (n, s = 2) => (`${new Array(s).fill(0)}${n}`).slice(-s);
        const d = new Date();
        const redactString = (key, value) => (typeof value === 'string' ? redactKey(value) : value);

        // The key is "{date}-{email}-{url}-{time}-{seconds.ms}". KV keys are at most
        // 512 bytes, so an address and a path that would not fit are cut (the date
        // in front and the time behind stay, so keys remain unique and sortable).
        const head = `{${pad(d.getFullYear(),4)}-${pad(d.getMonth()+1)}-${pad(d.getDate())}}-{`;
        const tail = `}-{${pad(d.getHours())}:${pad(d.getMinutes())}}-${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`;
        const room = KV_KEY_MAX_BYTES - new TextEncoder().encode(head + tail + '}-{').length;
        const emailPart = truncateUtf8(redactKey(email), Math.floor(room / 2));
        const urlPart = truncateUtf8(redactKey(url), room - new TextEncoder().encode(emailPart).length);
        const key = `${head}${emailPart}}-{${urlPart}${tail}`;

        // A failure is already JSON text ({"error": ..., "message": ...}), so it is
        // parsed and written once more through the redaction, never stored as a JSON
        // string of JSON.
        const value = typeof result === 'string'
            ? JSON.stringify(JSON.parse(result), redactString)
            : JSON.stringify(result, redactString);

        // The waitUntil function allows us to continue performing work in our Cloudflare Worker, without blocking.
        // Every string is redacted before it is stored, so the API key never reaches KV.
        event.waitUntil(LOGS.put(key, value));
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
 *   API_REGION unset / "global" / "default" / ""  ->  https://api.zerobounce.net/v2/validate
 *   API_REGION = "us" or "usa"                    ->  https://api-us.zerobounce.net/v2/validate
 *   API_REGION = "eu"                             ->  https://api-eu.zerobounce.net/v2/validate
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

    logLine(`Unknown API_REGION: ${API_REGION}. Falling back to ${DEFAULT_VALIDATE_URL}.`);

    return DEFAULT_VALIDATE_URL;
}

/**
 * Milliseconds before the validation request is aborted when the optional
 * API_TIMEOUT binding is not set (or is null).
 */
const DEFAULT_API_TIMEOUT_MS = 10000;

/** The longest API_TIMEOUT accepted: ten minutes, far beyond any Worker's wall-clock budget. */
const MAX_API_TIMEOUT_MS = 600000;

/**
 * The timeout from the optional API_TIMEOUT binding: a whole number of
 * milliseconds from 1 to 600000, as a number or as a string of digits. Any
 * other value (including an empty string, 0, a fraction, a number above the
 * maximum, Infinity or text) is logged and replaced by the default.
 */
function apiTimeout() {
    if (typeof API_TIMEOUT === 'undefined' || API_TIMEOUT === null) {
        return DEFAULT_API_TIMEOUT_MS;
    }

    const timeout = typeof API_TIMEOUT === 'number'
        ? API_TIMEOUT
        : (typeof API_TIMEOUT === 'string' && /^\s*[0-9]+\s*$/.test(API_TIMEOUT) ? Number(API_TIMEOUT) : NaN);

    if (Number.isInteger(timeout) && timeout >= 1 && timeout <= MAX_API_TIMEOUT_MS) {
        return timeout;
    }

    logLine(`Invalid API_TIMEOUT: ${JSON.stringify(String(API_TIMEOUT))}. It must be a whole number of milliseconds from 1 to ${MAX_API_TIMEOUT_MS}. Using ${DEFAULT_API_TIMEOUT_MS} ms.`);

    return DEFAULT_API_TIMEOUT_MS;
}

/** What is logged or stored instead of a text whose decoded views still hold the key. */
const CREDENTIAL_OMITTED_MESSAGE = 'the response text was omitted because it contained a credential';

/** The UTF-8 sequence length a lead byte announces, or 0 for a byte no sequence starts with. */
function utf8SequenceLength(byte) {
    if (byte < 0x80) return 1;
    if (byte >= 0xc2 && byte <= 0xdf) return 2;
    if (byte >= 0xe0 && byte <= 0xef) return 3;
    if (byte >= 0xf0 && byte <= 0xf4) return 4;
    return 0;
}

/**
 * A run of %XX that is not valid UTF-8 as a whole, decoded one UTF-8 sequence
 * at a time: each valid sequence becomes its character and each byte that
 * starts none stays as its %XX, so a stray %FF in front of a percent-encoded
 * key still leaves the key readable in this view, whatever its characters.
 */
function percentRunDecoded(run) {
    const bytes = run.match(/%[0-9A-Fa-f]{2}/g);
    let out = '';
    let i = 0;
    while (i < bytes.length) {
        const length = utf8SequenceLength(parseInt(bytes[i].slice(1), 16));
        if (length) {
            try {
                out += decodeURIComponent(bytes.slice(i, i + length).join(''));
                i += length;
                continue;
            } catch (err) {
                // Not a complete, valid sequence: keep this byte as it is.
            }
        }
        out += bytes[i];
        i += 1;
    }
    return out;
}

/** %XX sequences decoded as UTF-8; a byte that is not part of valid UTF-8 stays as its %XX. */
function percentDecoded(text) {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
            return decodeURIComponent(run);
        } catch (err) {
            return percentRunDecoded(run);
        }
    });
}

const JSON_UNESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', "'": "'" };

function hexDigit(char) {
    const digit = parseInt(char, 16);
    return Number.isNaN(digit) ? -1 : digit;
}

function codePointText(code) {
    if (code < 0 || code > 0x10ffff) return '\uFFFD';
    return String.fromCodePoint(code);
}

/**
 * JSON and other backslash escapes, including `\u{27}`, `\047`, `\U{27}` and `\x27`.
 * `%u0027` is not an escape and is left unchanged.
 */
function jsonUnescaped(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '\\' || i + 1 >= text.length) {
            out += text[i];
            i += 1;
            continue;
        }
        const next = text[i + 1];
        if (Object.prototype.hasOwnProperty.call(JSON_UNESCAPES, next)) {
            out += JSON_UNESCAPES[next];
            i += 2;
            continue;
        }
        if ((next === 'u' || next === 'U') && text[i + 2] === '{') {
            let j = i + 3;
            let digits = '';
            while (j < text.length && digits.length < 8 && hexDigit(text[j]) >= 0) {
                digits += text[j];
                j += 1;
            }
            if (digits && text[j] === '}') {
                out += codePointText(parseInt(digits, 16));
                i = j + 1;
                continue;
            }
        }
        if (next === 'u' || next === 'U') {
            const wide = next === 'U';
            let hex = text.slice(i + 2, i + 2 + (wide ? 8 : 4));
            if (wide && hex.length === 8 && /^[0-9A-Fa-f]{8}$/.test(hex)) {
                const code = parseInt(hex, 16);
                if (code <= 0x10ffff) {
                    out += codePointText(code);
                    i += 10;
                    continue;
                }
                hex = text.slice(i + 2, i + 6);
            }
            if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
                let code = parseInt(hex, 16);
                if (code >= 0xd800 && code <= 0xdbff && text[i + 6] === '\\' && text[i + 7] === 'u') {
                    const low = text.slice(i + 8, i + 12);
                    if (/^[0-9A-Fa-f]{4}$/.test(low)) {
                        const lowCode = parseInt(low, 16);
                        if (lowCode >= 0xdc00 && lowCode <= 0xdfff) {
                            code = 0x10000 + ((code - 0xd800) << 10) + (lowCode - 0xdc00);
                            out += codePointText(code);
                            i += 12;
                            continue;
                        }
                    }
                }
                out += codePointText(code);
                i += 6;
                continue;
            }
        }
        if (next === 'x' || next === 'X') {
            if (text[i + 2] === '{') {
                let j = i + 3;
                let digits = '';
                while (j < text.length && digits.length < 6 && hexDigit(text[j]) >= 0) {
                    digits += text[j];
                    j += 1;
                }
                if (digits && text[j] === '}') {
                    out += codePointText(parseInt(digits, 16));
                    i = j + 1;
                    continue;
                }
            }
            if (hexDigit(text[i + 2]) >= 0 && hexDigit(text[i + 3]) >= 0) {
                out += String.fromCharCode(hexDigit(text[i + 2]) * 16 + hexDigit(text[i + 3]));
                i += 4;
                continue;
            }
        }
        if (next >= '0' && next <= '7') {
            let value = next.charCodeAt(0) - 48;
            let len = 2;
            if (next <= '3' && text[i + 2] >= '0' && text[i + 2] <= '7') {
                value = value * 8 + (text[i + 2].charCodeAt(0) - 48);
                len = 3;
                if (text[i + 3] >= '0' && text[i + 3] <= '7') {
                    value = value * 8 + (text[i + 3].charCodeAt(0) - 48);
                    len = 4;
                }
            } else if (text[i + 2] >= '0' && text[i + 2] <= '7') {
                value = value * 8 + (text[i + 2].charCodeAt(0) - 48);
                len = 3;
            }
            out += String.fromCharCode(value);
            i += len;
            continue;
        }
        out += text[i];
        i += 1;
    }
    return out;
}

/** Full case fold of one scalar via the default Unicode mappings, with no locale. */
function foldedScalars(scalar) {
    let current = [scalar];
    for (let round = 0; round < 3; round++) {
        const next = [];
        for (const item of current) {
            for (const upper of item.toUpperCase()) {
                for (const lower of upper.toLowerCase()) {
                    next.push(lower);
                }
            }
        }
        if (next.join('') === current.join('')) break;
        current = next;
    }
    return current;
}

/** NFD, the default full case fold, NFD again (the fold can compose), then drop U+0307 after `i`. */
function simpleFoldSpelling(text) {
    let folded = [];
    for (const scalar of [...String(text).normalize('NFD')]) {
        folded.push(...foldedScalars(scalar));
    }
    folded = [...folded.join('').normalize('NFD')];
    return folded
        .filter((scalar, index) => !(scalar.codePointAt(0) === 0x307 && index > 0 && folded[index - 1] === 'i'))
        .join('');
}

/**
 * HTML named entities for the characters an API key can hold (ASCII letters
 * and digits are never spelled by name) plus the usual escapes; matched in
 * lower case, with or without the closing ";".
 */
const HTML_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    tab: '\t', newline: '\n', excl: '!', num: '#', dollar: '$', percnt: '%',
    lpar: '(', rpar: ')', ast: '*', midast: '*', plus: '+', comma: ',', period: '.',
    sol: '/', colon: ':', semi: ';', equals: '=', quest: '?', commat: '@',
    lsqb: '[', lbrack: '[', bsol: '\\', rsqb: ']', rbrack: ']', hat: '^',
    lowbar: '_', underbar: '_', grave: '`', lcub: '{', lbrace: '{', verbar: '|', vert: '|',
    rcub: '}', rbrace: '}', tilde: '~', hyphen: '-', dash: '-', minus: '-',
};

/**
 * Numeric (`&#39;`, `&#x27;`, zero-padded, `;` optional, any case of the x) and
 * the named entities above. One left-to-right pass, so the cost is linear.
 */
function htmlUnescaped(text) {
    if (!text.includes('&')) return text;
    const entity = /&(?:#([0-9]+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]*))(;?)/y;
    let out = '';
    let last = 0;
    let i = text.indexOf('&');
    while (i !== -1) {
        entity.lastIndex = i;
        const match = entity.exec(text);
        let decoded = null;
        if (match) {
            if (match[1] !== undefined || match[2] !== undefined) {
                const digits = (match[1] !== undefined ? match[1] : match[2]).replace(/^0+(?=.)/, '');
                // Beyond eight digits is beyond every code point; avoid a huge parse.
                decoded = codePointText(digits.length > 8 ? 0x110000 : parseInt(digits, match[1] !== undefined ? 10 : 16));
            } else {
                const name = match[3].toLowerCase();
                if (Object.prototype.hasOwnProperty.call(HTML_ENTITIES, name)) {
                    decoded = HTML_ENTITIES[name];
                }
            }
        }
        if (decoded === null) {
            i = text.indexOf('&', i + 1);
            continue;
        }
        out += text.slice(last, i) + decoded;
        last = i + match[0].length;
        i = text.indexOf('&', last);
    }
    return out + text.slice(last);
}

/** The Worker's own request encoding plus three echo layers (standard.md §3). */
const DECODE_LAYERS = 4;

/**
 * Whether any view of the text reached by up to four decodings, in any
 * order, contains the key: URL (%XX), form ("+" as a space, then %XX), JSON
 * and HTML entities.
 */
function holdsKey(text, key) {
    const decoders = [percentDecoded, (view) => percentDecoded(view.split('+').join(' ')), jsonUnescaped, htmlUnescaped];
    const views = new Set([text]);
    let layer = [text];
    for (let depth = 0; depth < DECODE_LAYERS; depth++) {
        const next = [];
        for (const view of layer) {
            for (const decode of decoders) {
                const decoded = decode(view);
                if (!views.has(decoded)) {
                    views.add(decoded);
                    next.push(decoded);
                }
            }
        }
        layer = next;
    }
    const foldedKey = simpleFoldSpelling(key);
    for (const view of views) {
        if (view.includes(key)) {
            return true;
        }
        if (foldedKey && simpleFoldSpelling(view).includes(foldedKey)) {
            return true;
        }
    }
    return false;
}

/**
 * Removes the API key from text that is about to be logged or stored. A text
 * that still holds the key in a spelling the list below misses (it decodes to
 * the key) is replaced as a whole with a fixed message.
 */
function redactKey(text) {
    const value = String(text);
    if (typeof API_KEY === 'undefined' || !API_KEY) {
        return value;
    }
    const key = String(API_KEY);
    // Composed from the encoders a body can apply: the raw key and each one-
    // or two-step JSON quoting of it (a body quoting a JSON copy of the key,
    // and a JSON copy of that quote), with or without "/" escaped as "\/" at
    // each step; each as is, URL-encoded (spaces as %20) and form-encoded as
    // URLSearchParams writes it ("+", "'" as %27, as in the request URL), for
    // a body that echoes the request URL-encoded. Longest first, so no form
    // leaves part of a longer one behind.
    const quotings = [
        (text) => JSON.stringify(text).slice(1, -1),
        // JSON.stringify has already escaped every backslash, so "/" as "\/" completes it.
        (text) => JSON.stringify(text).slice(1, -1).split('/').join('\\/'),
    ];
    const encodings = [
        (text) => text,
        // A lone surrogate (a key the check refuses, but logs still redact) makes
        // encodeURIComponent throw; it is encoded as U+FFFD, as URLSearchParams does.
        (text) => encodeURIComponent(text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')),
        (text) => new URLSearchParams({ s: text }).toString().slice(2),
    ];
    const quoted = [key];
    for (const once of quotings) {
        quoted.push(once(key));
        for (const twice of quotings) {
            quoted.push(twice(once(key)));
        }
    }
    const forms = [...new Set(quoted.flatMap((text) => encodings.map((encode) => encode(text))))]
        .sort((a, b) => b.length - a.length);
    const redacted = forms.reduce((text, form) => text.split(form).join('***'), value);
    return holdsKey(redacted, key) ? CREDENTIAL_OMITTED_MESSAGE : redacted;
}

/** Deeper JSON than any ZeroBounce answer; a body nested past it is refused unparsed. */
const MAX_JSON_DEPTH = 512;

/** Whether the JSON text nests arrays or objects deeper than MAX_JSON_DEPTH (strings skipped). */
function jsonNestedTooDeep(text) {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (char === '\\') i += 1;
            else if (char === '"') inString = false;
        } else if (char === '"') {
            inString = true;
        } else if (char === '[' || char === '{') {
            depth += 1;
            if (depth > MAX_JSON_DEPTH) return true;
        } else if (char === ']' || char === '}') {
            depth -= 1;
        }
    }
    return false;
}

/**
 * A failed validation, as the JSON text this function has always returned for
 * one. Built with JSON.stringify so quotes in a message keep it valid JSON.
 *
 * Every failure is logged as an error: the Worker fails open (the submission
 * is forwarded unvalidated, as the README documents), but never silently.
 */
function validationFailure(name, message) {
    // The name is redacted too: a thrown error's name is not always platform-fixed.
    const safeName = redactKey(name);
    const safeMessage = redactKey(message);
    errorLine(`ZeroBounce validation failed (${safeName}): ${safeMessage}. The submission is forwarded unvalidated.`);
    return JSON.stringify({ error: safeName, message: safeMessage });
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
 * real false success flag, or a non-empty error, error_message or Error
 * string. A real flag is a boolean, the number 0 or 1 (including 1.0), or
 * "true" / "false" / "0" / "1" in any case, trimmed. Anything else, including
 * "x" and 0.4, is not a flag. A validation result has neither.
 */
function isSuccessFlag(value) {
    if (typeof value === 'boolean') return true;
    if (typeof value === 'number' && (value === 0 || value === 1)) return true;
    if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        return text === 'true' || text === 'false' || text === '0' || text === '1';
    }
    return false;
}

function isFalseSuccessFlag(value) {
    if (!isSuccessFlag(value)) return false;
    if (typeof value === 'boolean') return value === false;
    if (typeof value === 'number') return value === 0;
    const text = value.trim().toLowerCase();
    return text === 'false' || text === '0';
}

function isApiErrorBody(data) {
    if (isFalseSuccessFlag(data.success)) {
        return true;
    }
    return ['error', 'error_message', 'Error'].some(
        (key) => typeof data[key] === 'string' && data[key].trim() !== ''
    );
}

/**
 * Whether the API_KEY binding is unusable. A key is printable ASCII, U+0021 to
 * U+007E, and nothing else: an empty key, a space (even in the middle: a
 * pasted key often carries one), a control, any other whitespace, any
 * invisible or formatting character and any non-ASCII character is refused
 * before any request, so the key cannot be sent corrupted as a header-like
 * or percent-encoded oddity and fail on every call.
 */
function apiKeyRejected(key) {
    return !/^[\x21-\x7e]+$/.test(String(key));
}

/** The statuses the API documents; any other 2xx status is not a validation result. */
const API_STATUSES = ['valid', 'invalid', 'catch-all', 'unknown', 'spamtrap', 'abuse', 'do_not_mail'];

/**
 * Validates an email using the ZeroBounce real-time email validation API
 * The fetch request can be aborted automatically using a timeout.
 * The function is async however it waits itself for the response.
 *
 * Returns the API's answer (an object with a documented `status`) or, for
 * every failure, the JSON text of validationFailure; the caller then forwards
 * the submission unvalidated.
 */
async function validateEmail(email, ip_address) {
    if (typeof API_KEY === 'undefined' || API_KEY === null) {
        return validationFailure('Missing API_KEY', 'API_KEY is not set; add it as a secret in the Worker settings');
    }

    // A pasted key often carries a trailing newline or space, which would
    // be sent as %0A or + and fail on every request. Refuse it, without
    // logging the key itself.
    if (apiKeyRejected(API_KEY)) {
        return validationFailure('Invalid API_KEY', 'API_KEY is empty or has a character outside printable ASCII (U+0021 to U+007E), such as whitespace, a control or an invisible character; check the secret');
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

        // An HTML page (a proxy or challenge page) is never a validation
        // result, even when its body happens to parse as JSON.
        if (String(resp.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
            return validationFailure(`HTTP ${resp.status}`, 'ZeroBounce returned an HTML page instead of an API response');
        }

        // A body cut short throws here, as the transport error it is.
        // resp.text() would drop a leading byte order mark, which is not
        // JSON (RFC 8259), so the bytes are decoded with the mark kept.
        const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await resp.arrayBuffer());
        if (jsonNestedTooDeep(text)) {
            // Storing or logging it would overflow the stack (JSON.stringify).
            return validationFailure(`HTTP ${resp.status}`, 'ZeroBounce returned a response nested too deeply to read');
        }
        let data;
        try {
            data = JSON.parse(text);
        } catch (err) {
            // A 2xx that is not JSON (plain text, or CSV under
            // application/json) is an API error with its status.
            return validationFailure(`HTTP ${resp.status}`, 'ZeroBounce returned a response that is not JSON');
        }

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

        if (typeof data.status !== 'string' || typeof data.address !== 'string') {
            // Field types are part of the shape: a result has address and
            // status as strings. A {"status": 1} or {"status": null} is not
            // a result and must not rewrite the address (fail open).
            return validationFailure(`HTTP ${resp.status}`, 'ZeroBounce returned a validation result whose address or status is not a string');
        }

        // The status must be one the API documents. Anything else (an echoed
        // string, a new value this Worker does not know) is not a result the
        // allow-list can judge: fail open, and never log the text.
        const status = data.status.trim().toLowerCase();
        if (!API_STATUSES.includes(status)) {
            return validationFailure(`HTTP ${resp.status}`, 'ZeroBounce returned a validation result with a status that is not one of the documented statuses');
        }
        data.status = status;

        return data;
    } catch (err) {
        // A network error, a timeout, a body cut short, or some other problem.
        return validationFailure(err && err.name ? err.name : 'Error', err && err.message ? err.message : String(err));
    }
}

/**
 * A binding that holds a list (VALID_STATUS, BYPASS_PATH) as an array of
 * strings. A string binding is read as JSON when it is a JSON array
 * (`["valid", "catch-all"]`) and otherwise as a single entry; a blank string
 * is no list. Returns null when the binding is not set, or holds no usable
 * list, in which case the problem is logged (once per request).
 */
function bindingList(name, value) {
    if (value === undefined || value === null) {
        return null;
    }
    let list = value;
    if (typeof value === 'string') {
        const text = value.trim();
        if (text === '') {
            return null;
        }
        list = [text];
        if (text.startsWith('[')) {
            try {
                list = JSON.parse(text);
            } catch (err) {
                // Not JSON: one entry that happens to start with "[".
            }
        }
    }
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
        logLine(`Ignoring ${name}: it must be a JSON array of strings, or a single string.`);
        return null;
    }
    return list;
}

/** Forwards the request with a new body, keeping its method, headers and URL. */
async function forwardWithBody(request, body) {
    const newRequest = new Request(
        request.url.toString(),
        new Request(request, { body })
    );

    logLine(`Returning modified request.`);

    return await fetch(newRequest);
}

/**
 * Validates one address and says what to do with the form. Returns null when
 * the validation did not produce a status (the submission is forwarded
 * untouched: fail open), else {rewrite, rejected}: rewrite is false when no
 * VALID_STATUS list is set.
 */
async function validateAddress(event, email, pathname, clientIP, validStatus) {
    const validate = await validateEmail(email, clientIP);

    await logValidation(event, email, pathname, validate);

    if (validate === null || typeof validate !== 'object' || typeof validate.status !== 'string') {
        return null;
    }

    logLine(`Email validation status: ${validate.status}`);

    return {
        rewrite: validStatus !== null,
        rejected: validStatus !== null && !validStatus.includes(validate.status),
    };
}

/**
 * The handler function for the event listener.
 */
async function handleRequest(event) {
    // An error here will return the origin response, as if the Worker wasn’t present.
    const request = event.request;

    if (request.method === 'POST') {
        logLine(`Incoming correct request: ${request.method}`);

        const {
            headers
        } = request;
        const contentType = headers.get('content-type');
        const {
            pathname
        } = new URL(request.url);
        const clientIP = headers.get('CF-Connecting-IP');

        // Read once per request, so a malformed binding is logged once.
        const bypassPath = bindingList('BYPASS_PATH', typeof BYPASS_PATH === 'undefined' ? undefined : BYPASS_PATH);
        const validStatus = bindingList('VALID_STATUS', typeof VALID_STATUS === 'undefined' ? undefined : VALID_STATUS);

        if (bypassPath !== null && bypassPath.includes(pathname)) {
            logLine(`BYPASS_PATH set for: ${pathname}. Returning original request.`);
            return await fetch(request);
        }

        if (contentType) {
            logLine(`Incoming content type: ${contentType}`);

            if (mediaType(contentType) === 'multipart/form-data') {
                // The body is read part by part and never decoded or
                // re-encoded as a whole: file parts reach the origin byte for
                // byte, and a rejected address is replaced in place.
                const _body = new Uint8Array(await request.clone().arrayBuffer());
                const boundary = multipartBoundary(contentType);
                const fields = boundary ? multipartFields(_body, boundary) : [];
                const chosen = chooseAddressField(fields);

                if (chosen !== null) {
                    const email = chosen.field.value.trim();
                    logLine(`Matched email: ${email}`);

                    const outcome = await validateAddress(event, email, pathname, clientIP, validStatus);

                    if (outcome !== null && outcome.rewrite) {
                        const targets = fieldsToRewrite(fields, chosen, outcome.rejected);

                        if (targets.length > 0) {
                            // Change body
                            return await forwardWithBody(request, replaceFieldValues(_body, targets, 'INVALID'));
                        }
                    }
                } else {
                    // Never log the body itself: it can hold passwords and other form fields.
                    logLine(`Unable to find an email match in a multipart body of ${_body.byteLength} bytes.`);
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
                // The field named email (then your-email) whose value is an address.
                // Method 2:
                // Otherwise the first field whose value is an email address. This
                // applies when the email input is not named accordingly (email).
                // ==========================================================
                const chosen = chooseAddressField(fields);

                if (chosen !== null) {
                    const email = chosen.field.value.trim();
                    logLine(chosen.named ? `Found email input: ${email}` : `Matched email: ${email}`);

                    const outcome = await validateAddress(event, email, pathname, clientIP, validStatus);

                    if (outcome !== null && outcome.rewrite) {
                        const targets = fieldsToRewrite(fields, chosen, outcome.rejected);

                        if (targets.length > 0) {
                            // The incoming Content-Type header is carried
                            // over to the new request, so the body stays
                            // URL-encoded.
                            return await forwardWithBody(request, replaceFieldValues(_body, targets, 'INVALID'));
                        }
                    }
                } else {
                    // Never log the body itself: it can hold passwords and other form fields.
                    logLine(`Unable to find an email match in a form body of ${_body.byteLength} bytes.`);
                }

                // Return original request untouched
                logLine(`Returning original request, nothing done.`);
                return await fetch(request);
            }
            // Experimental
            else if (mediaType(contentType) === 'application/json') {
                // A body that is not JSON, or has no "form" string holding a
                // JSON object, is forwarded untouched.
                let _body = null;
                let _form = null;
                try {
                    _body = await request.clone().json();
                    if (_body && typeof _body === 'object' && typeof _body.form === 'string') {
                        _form = JSON.parse(_body.form);
                    }
                } catch (err) {
                    logLine('Unable to read a JSON body; forwarding it untouched.');
                }

                if (_form && typeof _form === 'object' && !Array.isArray(_form)) {
                    // Only the keys "email" and "your-email", exactly: another
                    // field (email_password, emailConfirm) is not an address.
                    const fields = EMAIL_FIELD_NAMES
                        .filter((name) => Object.prototype.hasOwnProperty.call(_form, name))
                        .map((name) => ({ name, value: typeof _form[name] === 'string' ? _form[name] : '' }));
                    const chosen = chooseAddressField(fields);

                    if (chosen !== null && chosen.named) {
                        const email = chosen.field.value.trim();
                        logLine(`Matched email: ${email}`);

                        const outcome = await validateAddress(event, email, pathname, clientIP, validStatus);

                        if (outcome !== null && outcome.rewrite) {
                            const targets = fieldsToRewrite(fields, chosen, outcome.rejected);

                            if (targets.length > 0) {
                                for (const target of targets) {
                                    _form[target.name] = "INVALID";
                                }

                                _body.form = JSON.stringify(_form);

                                // Change body
                                return await forwardWithBody(request, JSON.stringify(_body));
                            }
                        }
                    } else {
                        logLine(`Unable to find an email match in a JSON body with ${Object.keys(_form).length} form fields.`);
                    }
                }

                // Return original request untouched
                return await fetch(request);
            }
        }
    }

    return await fetch(request);
}

// By using event.passThroughOnException, a Workers application will forward requests to your origin if an exception is thrown during the Worker’s execution.
// This allows you to add logging, tracking, or other features with Workers, without degrading your application’s functionality.
addEventListener("fetch", (event) => {
    event.passThroughOnException();
    event.respondWith(handleRequest(event));
});
