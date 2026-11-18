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
 * The email address pattern: a community-based expression, heavily modified to
 * our needs, written as a string. It is applied only to one decoded, trimmed
 * form value at a time (see regexFormValue), never to a whole body. The string
 * keeps the "(.*=)" prefix and "&" suffix of the form-body pattern it came
 * from; regexFormValue cuts them off.
 * What the address part accepts:
 - Latin characters ("a" - "z" or "A" - "Z") within the email address.
 - digits (0 - 9) in the email address.
 - domain part restrictions are enforced.
 - hyphens (-) inside the domain as long as they don't lead or trail the domain.
 - IP address literals surrounded with square brackets ([]) for the domain names.
 - sub-domains are restricted to a maximum length of 63 characters.
 - local part restrictions apply.
 - the set of special characters allowed by RFC 5322 ("!", "#", "$", "%", "&", "'", "*", "+", "-", "/", "=", "?", "^", "_", "`", "{", "|", "}", "~") may reside in the local part.
 - the quoted local part ("..."@) is dead code: the JS character class "[]!#-[^-~ \t]" in
   that branch is an empty class followed by text, not the intended "]" or "!" or "#" to "[" ranges, so a
   quoted local part never matches (and is therefore treated as "not an address", never sent to the
   API and, in an email field, rewritten to INVALID when VALID_STATUS is set).
 - no trailing, leading, or consecutive periods anywhere within the email address.
 - no Unicode characters.
 - the length of the entire address is not checked here (isAddress caps it at 320 characters).
 - obsolete syntax-related rules are ignored.
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
 * the start of a string. A field is an email field (`email: true`) when its
 * name contains "email", decoded or as sent (see isEmailFieldName).
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

            const rawName = bufferToText(equals === -1 ? raw : raw.subarray(0, equals));

            fields.push({
                name,
                value,
                valueStart: equals === -1 ? end : start + equals + 1,
                end,
                // An "@" as sent ("%40") counts like a decoded one.
                at: /%40/.test(bufferToText(raw.subarray(equals === -1 ? raw.length : equals + 1))),
                email: isEmailFieldName(name) || isEmailFieldName(rawName),
            });
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

/**
 * Which kind of form a Content-Type header announces, read from the whole
 * header, case-insensitively: {kind, ambiguous}. kind is 'multipart',
 * 'urlencoded', or 'other' (the JSON branch and everything else). A header
 * that holds a form type is ambiguous (the request is refused with a 400) when
 * it holds both form types, or when anything but white space precedes the
 * form type before the first ";" (`multipart/form-data, x`,
 * `multipart/form-data x`, `text/plain, multipart/form-data`): parsers disagree
 * on which media type such a header names, so the Worker will not read the body
 * one way while the origin reads it another.
 */
function contentTypeKind(contentType) {
    const text = String(contentType).toLowerCase();
    const multipart = text.includes('multipart/form-data');
    const urlencoded = text.includes('application/x-www-form-urlencoded');
    if (!multipart && !urlencoded) {
        return { kind: 'other', ambiguous: false };
    }
    const kind = multipart ? 'multipart' : 'urlencoded';
    const type = kind === 'multipart' ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
    return {
        kind,
        ambiguous: (multipart && urlencoded) || text.split(';')[0].trim() !== type,
    };
}

/** Characters RFC 2046 allows in a boundary (bchars), the space only inside. */
const BOUNDARY_CHARS = /^[0-9A-Za-z'()+_,\-./:=? ]+$/;

/**
 * The boundary of a multipart Content-Type header: {boundary, ambiguous}. The
 * parameters are parsed as a header does (a token or a quoted string with
 * backslash escapes). The word "boundary" more than once anywhere in the
 * header (as a second parameter, inside a quoted value, as "xboundary" or
 * "boundary*") is ambiguous: parsers disagree on which one wins, so the Worker
 * refuses the request (400) rather than read the body one way while the origin
 * reads it another. The one exception is the chosen boundary's own value:
 * browsers send boundaries such as "----WebKitFormBoundary0123", which hold
 * the word themselves.
 *
 * A boundary that is also empty, longer than 70 characters, ends in a space or
 * holds a character outside RFC 2046's bchars is ambiguous too, and so is an
 * unquoted one with a comma: the comma is a bchar, but PHP and undici cut an
 * unquoted value there. (A backslash is no bchar, so a boundary holding one is
 * refused here; there is no separate backslash rule.) A header that does not
 * mention "boundary" at all returns boundary null: the body is not read.
 */
function multipartBoundary(contentType) {
    const text = String(contentType);
    const count = (t) => (t.match(/boundary/gi) || []).length;
    const found = headerParameterList(text).filter(([name]) => name === 'boundary');
    const boundary = found.length === 1 ? found[0][1] : null;
    const own = boundary !== null ? count(boundary) : 0;
    let invalid = false;
    if (boundary !== null) {
        invalid = boundary === '' || boundary.length > 70 || boundary.endsWith(' ') || !BOUNDARY_CHARS.test(boundary) ||
            (boundary.includes(',') && !found[0][2]);
    }
    return {
        boundary: invalid ? null : boundary,
        // A header that mentions "boundary" (as boundary*, xboundary, inside a
        // quoted value) without one plain boundary parameter is ambiguous too:
        // PHP finds the word anywhere and reads the body, the Worker would not.
        ambiguous: count(text) - own > 1 || invalid || (boundary === null && count(text) > 0),
    };
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
 * The parameters of a header value (the text after the first ";") as a list of
 * [name, value, quoted, assigned] in order, names in lower case (quoted: the
 * value was a quoted string; assigned: the parameter has an "=", even with an
 * empty value): a linear scan that honours
 * quoted strings (with backslash escapes), so a filename that merely contains
 * `name="email"` does not set the field name.
 */
function headerParameterList(text) {
    const params = [];
    let i = text.indexOf(';');
    while (i !== -1 && i < text.length) {
        i += 1; // past ';'
        while (i < text.length && /[ \t]/.test(text[i])) i++;
        const nameStart = i;
        while (i < text.length && text[i] !== '=' && text[i] !== ';') i++;
        const paramName = text.slice(nameStart, i).trim().toLowerCase();
        let value = '';
        let quoted = false;
        const assigned = text[i] === '=';
        if (assigned) {
            i += 1;
            while (i < text.length && /[ \t]/.test(text[i])) i++;
            if (text[i] === '"') {
                quoted = true;
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
        if (paramName) {
            params.push([paramName, value, quoted, assigned]);
        }
    }
    return params;
}

/** The parameters of a header value as {name: value}; the first of a repeated name wins. */
function headerParameters(text) {
    const params = {};
    for (const [name, value] of headerParameterList(text)) {
        if (!Object.prototype.hasOwnProperty.call(params, name)) {
            params[name] = value;
        }
    }
    return params;
}

/**
 * An RFC 2231 extended parameter value, decoded: the text after the
 * `charset'language'` prefix (when there is one), percent-decoded.
 */
function extendedValue(value) {
    const match = /^[^']*'[^']*'([\s\S]*)$/.exec(value);
    return percentDecoded(match ? match[1] : value);
}

/** Whether the byte is a space, tab, CR or LF. */
function isAsciiSpace(byte) {
    return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

/** The transfer encodings that leave a part's bytes as the sender wrote them. */
const IDENTITY_ENCODINGS = ['7bit', '8bit', 'binary'];

/**
 * The fields of a multipart body, without decoding the body as text. Each is
 * {name, value, valueStart, end, opaque}: the decoded field name, the value
 * with surrounding space, tab, CR and LF removed, and the byte span of that
 * value (so a replacement keeps the whitespace around it). A part is found by
 * its delimiter line and read header by header up to the first blank line
 * (CRLF or bare LF). A delimiter line is "--boundary" followed only by spaces
 * or tabs and a line break, or by "--" (the closing delimiter).
 *
 * The body must be well formed, or the array carries `malformed` (a reason
 * text; null otherwise) and the Worker answers 400: PHP and undici read bytes
 * the Worker would skip. Malformed is: a header line that is neither
 * `Token: value` nor a fold (a line starting with a space or tab), a bare CR
 * or a NUL byte in a header block, a part whose headers have no blank line
 * after them, no closing delimiter, or the boundary again after the closing
 * delimiter (an epilogue such as "\r\n" is fine).
 *
 * A part is an email field (`email: true`) when its raw header block (every
 * header line up to the blank line, folded lines included) contains "email",
 * whatever the syntax of its Content-Disposition: the Worker does not try to
 * read names the way each origin does. A part whose Content-Disposition has a
 * filename or filename* parameter with an "=" (even `filename=""`) is a file
 * to PHP and undici: it is skipped, its bytes never read as an address and
 * never rewritten, whatever its headers or its filename say. A bare `filename`
 * with no "=" is a text field to PHP and is judged by its headers. The name is the parsed
 * Content-Disposition `name` (one that is exactly email, your-email or
 * your_email is preferred when a part repeats the header), or '' when none
 * parses. An email part with a transfer encoding other than 7bit, 8bit or
 * binary (quoted-printable, base64) is `opaque`: its value is not what an
 * origin that decodes it would read, so it cannot be validated. No regular
 * expression runs over body bytes here, so the cost is linear.
 */
function multipartFields(bytes, boundary) {
    const LF = 0x0a;
    const CR = 0x0d;
    const dashes = textToBuffer(`--${boundary}`);
    const isBlank = (byte) => byte === 0x20 || byte === 0x09;
    const delimiterAt = (index) => {
        const after = index + dashes.length;
        if (bytes[after] === 0x2d && bytes[after + 1] === 0x2d) {
            return true;
        }
        let i = after;
        while (isBlank(bytes[i])) i++;
        return bytes[i] === LF || (bytes[i] === CR && bytes[i + 1] === LF);
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
    fields.malformed = null;
    let closed = false;

    while (delimiter !== -1) {
        const after = delimiter + dashes.length;
        // The closing delimiter ends with "--"; the boundary must not come again after it.
        if (bytes[after] === 0x2d && bytes[after + 1] === 0x2d) {
            closed = true;
            if (indexOfBytes(bytes, dashes, after + 2) !== -1) {
                fields.malformed = 'the boundary appears again after the closing delimiter';
            }
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
        let headerEnd = start;
        while (position < end) {
            const lf = bytes.indexOf(LF, position);
            if (lf === -1 || lf >= end) {
                break;
            }
            const lineStop = lf > position && bytes[lf - 1] === CR ? lf - 1 : lf;
            if (lineStop === position) {
                bodyStart = lf + 1;
                headerEnd = position;
                break;
            }
            // Every line is checked as it is passed: a fold, or a token and a colon.
            const problem = headerLineProblem(bytes, position, lineStop);
            if (problem !== null) {
                fields.malformed = problem;
                return fields;
            }
            position = lf + 1;
        }
        if (bodyStart === -1) {
            fields.malformed = 'a part has no blank line after its headers';
            return fields;
        }

        // The raw header block decides whether this is an email field, whatever
        // the syntax of its Content-Disposition (an origin may read a name
        // that this parser does not). Folded lines are joined for parsing.
        const headerText = bufferToText(bytes.subarray(start, headerEnd));
        // A backslash escape inside a quoted name ("em\\ail") reads as the plain letters.
        const email = isEmailFieldName(headerText) || isEmailFieldName(headerText.replace(/\\/g, ''));
        const dispositions = [];
        let encoded = false;
        for (const line of headerText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
            const colon = line.indexOf(':');
            if (colon !== -1) {
                const header = line.slice(0, colon).trim().toLowerCase();
                if (header === 'content-disposition') {
                    dispositions.push(line.slice(colon + 1));
                } else if (header === 'content-transfer-encoding' && !IDENTITY_ENCODINGS.includes(line.slice(colon + 1).trim().toLowerCase())) {
                    encoded = true;
                }
            }
        }
        if (dispositions.length === 0) {
            continue;
        }

        const parsed = dispositions.map(headerParameters);
        const has = (params, key) => Object.prototype.hasOwnProperty.call(params, key);
        // RFC 2231 names (`name*=UTF-8''%65mail`, `name*0*=...`): the decoded
        // value counts as a name, for the email test and for the exact-name preference.
        for (const params of parsed) {
            for (const key of Object.keys(params)) {
                if (key.startsWith('name*')) {
                    params.encodedName = (params.encodedName || '') + extendedValue(params[key]);
                }
            }
        }
        const isEmail = email || parsed.some((params) => has(params, 'encodedName') && isEmailFieldName(params.encodedName));
        // A filename with a value (or an empty one, `filename=""`) makes a
        // file for PHP ($_FILES) and undici (File), whatever else the headers say.
        const isFile = dispositions.some((line) => headerParameterList(line).some(
            ([key, , , assigned]) => assigned && (key === 'filename' || key.startsWith('filename*'))
        ));
        if (isFile) {
            continue;
        }
        const nameOf = (params) => (has(params, 'name') ? params.name : params.encodedName);
        const named = parsed.find((params) => EXACT_EMAIL_NAMES.includes(nameOf(params))) || parsed.find((params) => nameOf(params) !== undefined);

        let valueStart = bodyStart;
        let valueEnd = Math.max(bodyStart, end);
        while (valueStart < valueEnd && isAsciiSpace(bytes[valueStart])) valueStart++;
        while (valueEnd > valueStart && isAsciiSpace(bytes[valueEnd - 1])) valueEnd--;
        fields.push({
            name: named ? nameOf(named) : '',
            value: bufferToText(bytes.subarray(valueStart, valueEnd)),
            valueStart,
            end: valueEnd,
            email: isEmail,
            opaque: isEmail && encoded,
        });
    }

    if (!closed && fields.malformed === null) {
        fields.malformed = 'there is no closing delimiter';
    }
    return fields;
}

/** Whether the byte may be in a header field name (an RFC 9110 token character). */
function isTokenByte(byte) {
    return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) ||
        (byte > 0x20 && byte < 0x7f && "!#$%&'*+-.^_`|~".includes(String.fromCharCode(byte)));
}

/**
 * Why the header line bytes[from, to) (line break excluded) is malformed, or
 * null: it holds a NUL byte or a CR (the one before the LF is left out by the
 * caller), or it is neither a fold (it starts with a space or tab) nor
 * `Token: value`. One pass over the line.
 */
function headerLineProblem(bytes, from, to) {
    for (let i = from; i < to; i++) {
        if (bytes[i] === 0x00) {
            return 'a part header holds a NUL byte';
        }
        if (bytes[i] === 0x0d) {
            return 'a part header holds a bare CR';
        }
    }
    if (bytes[from] === 0x20 || bytes[from] === 0x09) {
        return null;
    }
    let i = from;
    while (i < to && isTokenByte(bytes[i])) i++;
    if (i === from || bytes[i] !== 0x3a) {
        return 'a part header line is not "Name: value"';
    }
    return null;
}

/**
 * The names that mark the field a form uses for its address, whatever the
 * other email fields hold. The match is exact (after decoding).
 */
const EXACT_EMAIL_NAMES = ['email', 'your-email', 'your_email'];

/**
 * Whether a field name is an email field: it contains "email", in any case.
 * This does not depend on how an origin (PHP, say) parses a name, which keeps
 * changing: whatever the origin reads as an address field, its name or its
 * raw header carries those five letters.
 */
function isEmailFieldName(name) {
    return /email/i.test(String(name));
}

/** An address longer than this cannot be one (RFC 5321 allows 254). */
const MAX_ADDRESS_LENGTH = 320;

/**
 * The value without leading and trailing space, tab, CR and LF. Only those
 * four: String.trim() also strips no-break space and other Unicode white
 * space that an origin may keep as part of the value.
 */
function asciiTrim(value) {
    // A loop, not a regex: /^[ \t\r\n]+|[ \t\r\n]+$/g is quadratic on a long
    // run of blanks that does not reach the end, and values are attacker text.
    const text = String(value);
    const blank = (c) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
    let start = 0;
    let end = text.length;
    while (start < end && blank(text.charCodeAt(start))) {
        start++;
    }
    while (end > start && blank(text.charCodeAt(end - 1))) {
        end--;
    }
    return text.slice(start, end);
}

/** Whether the whole value, trimmed, is one address. Runs on at most 320 characters. */
function isAddress(value) {
    const text = asciiTrim(value);
    return text.length > 0 && text.length <= MAX_ADDRESS_LENGTH && regexFormValue.test(text);
}

/**
 * Picks the address to validate among the fields of a form: the first email
 * field named exactly `email`, `your-email` or `your_email` whose value is an
 * address; else the first email field whose value is an address; else (the
 * fallback, `fallback: true`) the first field of any name whose whole value is
 * an address. A field that cannot be read (`opaque`) is never chosen, and
 * nothing but an address is ever returned. Returns {field, fallback} or null.
 */
function chooseAddressField(fields) {
    const readable = fields.filter((f) => !f.opaque);
    const exact = readable.find((f) => f.email && EXACT_EMAIL_NAMES.includes(f.name) && isAddress(f.value));
    if (exact) {
        return { field: exact, fallback: false };
    }
    const any = readable.find((f) => f.email && isAddress(f.value));
    if (any) {
        return { field: any, fallback: false };
    }
    const field = readable.find((f) => isAddress(f.value));
    return field ? { field, fallback: true } : null;
}

/**
 * Whether two addresses are the same, ignoring surrounding space and ASCII
 * case only: toLowerCase() would also fold the Kelvin sign (U+212A) to "k".
 */
function sameAddress(a, b) {
    const lower = (value) => asciiTrim(value).replace(/[A-Z]/g, (c) => c.toLowerCase());
    return lower(a) === lower(b);
}

/** Whether an email field's value holds an "@" (decoded, or as sent for a URL-encoded field). */
function holdsAt(field) {
    return field.value.includes('@') || field.at === true;
}

/**
 * The fields to rewrite once the chosen address is validated (`chosen` is null
 * when there is none). Only one address costs a validation credit, so every
 * other address an origin might read from an email field would reach it
 * unvalidated. An email field counts when its value holds an "@" at all,
 * whether or not the regex calls it an address (`"bad"@y.com`, `<a@b>`,
 * `Name <a@b>`, `a@b,c@d`, Unicode, a trailing NUL): an origin may read an
 * address out of any of them, and none of them is ever sent to the API. A
 * rejected address rewrites the chosen field and every such field; an accepted
 * one rewrites every such field that is not exactly the validated address.
 * With no chosen address, every such field is rewritten. In the fallback, a
 * repeat of the chosen field's name follows the same rule. Other values stay.
 * An `opaque` field (a value that cannot be read) is always rewritten.
 */
function fieldsToRewrite(fields, chosen, rejected) {
    const address = chosen ? chosen.field.value : '';
    return fields.filter((f) => {
        if (f.opaque) {
            return f.forced || asciiTrim(f.value) !== '';
        }
        const at = f.email && holdsAt(f);
        if (chosen === null) {
            return at;
        }
        const hit = f === chosen.field || at ||
            (chosen.fallback && f.name === chosen.field.name && asciiTrim(f.value) !== '');
        return hit && (rejected || !sameAddress(f.value, address));
    });
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
    if (typeof LOGS === 'undefined') {
        return;
    }
    // A failure to log (LOGS is not a KV namespace, put throws at once) must
    // never stop the request: it is reported, and the submission carries on.
    try {
        const pad = (n, size = 2) => String(n).padStart(size, '0');
        const d = new Date();
        const redactString = (key, value) => (typeof value === 'string' ? redactKey(value) : value);

        // The key is "{date}-{email}-{url}-{time}-{seconds.ms}". KV keys are at most
        // 512 bytes, so an address and a path that would not fit are cut (the date
        // in front and the time behind stay). The key is sortable by date; two
        // validations of one address and path within the same millisecond would
        // write the same key, and the later one replaces the earlier.
        const head = `{${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}}-{`;
        const tail = `}-{${pad(d.getHours())}:${pad(d.getMinutes())}}-${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
        const room = KV_KEY_MAX_BYTES - new TextEncoder().encode(head + tail + '}-{').length;
        // Redacted first, then cut: a key straddling the cut would otherwise
        // leave its first half in the stored key.
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
        // A put that fails later (a rejected promise) is reported, not left unhandled.
        event.waitUntil(Promise.resolve(LOGS.put(key, value)).catch((err) => {
            errorLine(`Unable to write the validation log to KV: ${err && err.message ? err.message : String(err)}`);
        }));
    } catch (err) {
        errorLine(`Unable to write the validation log to KV: ${err && err.message ? err.message : String(err)}`);
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

/**
 * The longest API_TIMEOUT accepted: ten minutes. Cloudflare sets no hard
 * duration limit on an HTTP Worker (its limit is CPU time), but the visitor's
 * request waits as long as the validation does, so a longer timeout is not useful.
 */
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
    // A key of only white space is refused as a key (apiKeyRejected), and
    // masking it would hide every space in every log line.
    if (key.trim() === '') {
        return value;
    }
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
 * member (a string with text, a number other than 0, true, a non-empty array
 * or object). A real flag is a boolean, the number 0 or 1 (including 1.0), or
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
    return ['error', 'error_message', 'Error'].some((key) => isErrorMember(data[key]));
}

/** Whether an error member holds something: text, a number other than 0, true, or a non-empty array or object. */
function isErrorMember(value) {
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && typeof value === 'object' && Object.keys(value).length > 0;
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
 * Quotes and brackets that are never part of a status or a path: ASCII
 * `[ ] ' " backtick`, every character of the Unicode categories Pi and Pf
 * (initial and final quotes), U+2018 to U+201F (the curly quotes zerobounce.net's
 * guide prints: `[‘valid’, ‘catch-all’]`), the acute accent U+00B4, primes
 * U+2032 to U+2037 and the guillemets U+00AB and U+00BB.
 */
const LIST_JUNK = /[\[\]'"`\p{Pi}\p{Pf}‘-‟´′-‷«»]/gu;

/**
 * The entries of a list binding, whatever way it was typed. A typed array, or
 * a text that is a JSON array of strings, gives its items, each cleaned of
 * quotes and brackets (LIST_JUNK) and of separators at its ends. Any other text (a plain value,
 * `valid, catch-all`, `valid;catch-all`, `valid|catch-all`, `[valid, catch-all]`,
 * or a list in the curly quotes the guide prints) has the same characters
 * removed and is split on commas, semicolons, pipes and white space. Empty
 * entries are dropped. Returns null when the value is neither text nor an
 * array of strings.
 */
function listEntries(value) {
    let items = value;
    if (typeof value === 'string') {
        items = null;
        const text = value.trim();
        if (text.startsWith('[')) {
            try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
                    items = parsed;
                }
            } catch (err) {
                // Not JSON: read it as text.
            }
        }
        if (items === null) {
            return text.replace(LIST_JUNK, '').split(/[,;|\s]+/).map((item) => item.trim()).filter((item) => item !== '');
        }
    }
    if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) {
        return null;
    }
    return items.map((item) => trimSeparators(item.replace(LIST_JUNK, ''))).filter((item) => item !== '');
}

/** The text without leading and trailing commas, semicolons, pipes and white space (a loop, not a regex: linear). */
function trimSeparators(text) {
    const separator = (char) => char === ',' || char === ';' || char === '|' || /\s/.test(char);
    let start = 0;
    let end = text.length;
    while (start < end && separator(text[start])) start++;
    while (end > start && separator(text[end - 1])) end--;
    return text.slice(start, end);
}

/**
 * A binding that holds a list (VALID_STATUS, BYPASS_PATH) as an array of
 * non-empty strings (see listEntries). With `lower`, the binding is a list of
 * statuses: every entry is lower-cased, an entry that is not one of the API's
 * statuses is logged ("Ignoring unknown status") and dropped, since it can
 * never match. Paths match exactly. Returns null when the binding is not set
 * or holds no usable entry; the problem is logged (once per request).
 */
function bindingList(name, value, lower = false) {
    if (value === undefined || value === null) {
        return null;
    }
    let list = listEntries(value);
    if (list === null) {
        logLine(`Ignoring ${name}: it must be a list of strings (a JSON array is preferred).`);
        return null;
    }
    if (lower) {
        list = list.map((item) => item.toLowerCase());
        const unknown = list.filter((item) => !API_STATUSES.includes(item));
        for (const item of unknown) {
            logLine(`Ignoring unknown status ${JSON.stringify(item)} in ${name}. The statuses are ${API_STATUSES.join(', ')}.`);
        }
        list = list.filter((item) => API_STATUSES.includes(item));
    }
    if (list.length === 0) {
        logLine(`Ignoring ${name}: it holds no entry.`);
        return null;
    }
    return list;
}

/** Forwards the request with a new body, keeping its method, headers and URL. */
async function forwardWithBody(request, body) {
    // The incoming Content-Length describes the old body: the runtime sets the new one.
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    const newRequest = new Request(
        request.url.toString(),
        new Request(request, { body, headers })
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
        const validStatus = bindingList('VALID_STATUS', typeof VALID_STATUS === 'undefined' ? undefined : VALID_STATUS, true);

        if (bypassPath !== null && bypassPath.includes(pathname)) {
            logLine(`BYPASS_PATH set for: ${pathname}. Returning original request.`);
            return await fetch(request);
        }

        if (contentType) {
            // Only the media type is logged: the parameters are attacker-sized.
            logLine(`Incoming content type: ${mediaType(contentType).slice(0, 100)}`);

            const { kind, ambiguous: ambiguousType } = contentTypeKind(contentType);
            if (ambiguousType) {
                // Parsers disagree on which media type such a header names.
                errorLine('Refusing a request whose Content-Type names more than one form type or holds more than the form type before its parameters.');
                return new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } });
            }

            if (kind === 'multipart') {
                // The body is read part by part and never decoded or
                // re-encoded as a whole: file parts reach the origin byte for
                // byte, and a rejected address is replaced in place.
                const { boundary, ambiguous } = multipartBoundary(contentType);
                if (ambiguous) {
                    // Parsers disagree on which of two boundaries wins (or the
                    // boundary is not one RFC 2046 allows), so the body cannot
                    // be read the way the origin will read it.
                    errorLine('Refusing a multipart request whose Content-Type has more than one boundary parameter or an invalid boundary.');
                    return new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } });
                }
                const _body = new Uint8Array(await request.clone().arrayBuffer());
                const fields = boundary ? multipartFields(_body, boundary) : [];
                if (fields.malformed) {
                    // PHP and undici read bytes this parser would skip, so the
                    // body cannot be read the way the origin will read it.
                    errorLine(`Refusing a multipart body that is not well formed: ${fields.malformed}.`);
                    return new Response('Bad Request', { status: 400, headers: { 'content-type': 'text/plain' } });
                }
                const chosen = chooseAddressField(fields);
                let targets = [];

                if (chosen !== null) {
                    const email = asciiTrim(chosen.field.value);
                    logLine(`Matched email: ${email}`);

                    const outcome = await validateAddress(event, email, pathname, clientIP, validStatus);

                    if (outcome !== null && outcome.rewrite) {
                        targets = fieldsToRewrite(fields, chosen, outcome.rejected);
                    }
                } else {
                    // Never log the body itself: it can hold passwords and other form fields.
                    logLine(`Unable to find an email match in a multipart body of ${_body.byteLength} bytes.`);
                    if (validStatus !== null) {
                        // Only a part that cannot be read (transfer-encoded) is left.
                        targets = fieldsToRewrite(fields, null, true);
                    }
                }

                if (targets.length > 0) {
                    // Change body
                    return await forwardWithBody(request, replaceFieldValues(_body, targets, 'INVALID'));
                }

                // Return original request untouched
                return await fetch(request);
            } else if (kind === 'urlencoded') {
                // The body is split into fields but never decoded or
                // re-encoded as a whole: every field reaches the origin
                // exactly as it was sent, and a rejected address is replaced
                // in place.
                const _body = new Uint8Array(await request.clone().arrayBuffer());
                const fields = formFields(_body);

                // The first field named exactly email, your-email or your_email
                // whose value is an address; else the first email field (its
                // name contains "email") holding an address; else the first
                // field of any name whose value is an address (the input is
                // not named accordingly).
                // ==========================================================
                const chosen = chooseAddressField(fields);

                if (chosen !== null) {
                    const email = asciiTrim(chosen.field.value);
                    logLine(chosen.fallback ? `Matched email: ${email}` : `Found email input: ${email}`);

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
                    if (validStatus !== null) {
                        // An email field that holds an "@" without being an address.
                        const targets = fieldsToRewrite(fields, null, true);

                        if (targets.length > 0) {
                            return await forwardWithBody(request, replaceFieldValues(_body, targets, 'INVALID'));
                        }
                    }
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
                    // Every key that contains "email". A value that is not a
                    // string cannot be validated; it is opaque, and is set to
                    // "INVALID" when VALID_STATUS is set.
                    const fields = Object.keys(_form)
                        .filter(isEmailFieldName)
                        .map((name) => (typeof _form[name] === 'string'
                            ? { name, value: _form[name], email: true }
                            : { name, value: '', email: true, opaque: true, forced: true }));
                    const chosen = chooseAddressField(fields);
                    let targets = [];

                    if (chosen !== null) {
                        const email = asciiTrim(chosen.field.value);
                        logLine(`Matched email: ${email}`);

                        const outcome = await validateAddress(event, email, pathname, clientIP, validStatus);

                        if (outcome !== null && outcome.rewrite) {
                            targets = fieldsToRewrite(fields, chosen, outcome.rejected);
                        }
                    } else {
                        logLine(`Unable to find an email match in a JSON body with ${Object.keys(_form).length} form fields.`);
                        if (validStatus !== null) {
                            targets = fieldsToRewrite(fields, null, true);
                        }
                    }

                    if (targets.length > 0) {
                        for (const target of targets) {
                            _form[target.name] = "INVALID";
                        }

                        _body.form = JSON.stringify(_form);

                        // Change body (re-serialised: number spelling and white space may change)
                        return await forwardWithBody(request, JSON.stringify(_body));
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
