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
 * Logs validations into the Worker KV Namespace
 */
function logValidation(event, email, url, result) {
    if (typeof LOGS !== 'undefined') {
        const pad = (n, s = 2) => (`${new Array(s).fill(0)}${n}`).slice(-s);
        const d = new Date();

        // The waitUntil function allows us to continue performing work in our Cloudflare Worker, without blocking.
        event.waitUntil(LOGS.put(`{${pad(d.getFullYear(),4)}-${pad(d.getMonth()+1)}-${pad(d.getDate())}}-{${email}}-{${url}}-{${pad(d.getHours())}:${pad(d.getMinutes())}}-${pad(d.getSeconds())}.${pad(d.getMilliseconds(),3)}`,
            JSON.stringify(result)));
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
    return value.split(String(API_KEY)).join('***').split(encodeURIComponent(String(API_KEY))).join('***');
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
function apiErrorText(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return 'ZeroBounce returned an unexpected response.';
    }
    for (const key of ['error', 'error_message', 'Error', 'message', 'Message']) {
        if (typeof data[key] === 'string' && data[key].trim()) {
            return data[key].trim();
        }
    }
    return 'ZeroBounce returned no validation status.';
}

/**
 * Validates an email using the ZeroBounce real-time email validation API
 * The fetch request can be aborted automatically using a timeout.
 * The function is async however it waits itself for the response.
 */
async function validateEmail(email, ip_address) {
    if (typeof API_KEY !== 'undefined') {
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

            const data = await resp.json();

            if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'status')) {
                // A dead or invalid key, or another API error, on any HTTP status.
                const failure = validationFailure(`HTTP ${resp.status}`, apiErrorText(data));
                return data && typeof data === 'object' ? data : failure;
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

            if (contentType.includes('multipart/form-data')) {
                const _body = await request.clone().arrayBuffer();

                let _body_text = bufferToText(_body);

                let m;
                if ((m = regexBodyBuffer.exec(_body_text)) !== null) {
                    const email = m[2];
                    console.log(`Matched email: ${email}`);

                    let validate = await validateEmail(email, clientIP);

                    await logValidation(event, email, pathname, validate);

                    if (validate.hasOwnProperty('status')) {
                        console.log(`Email validation status: ${validate.status}`);

                        if (typeof VALID_STATUS !== 'undefined' && !VALID_STATUS.includes(validate.status)) {
                            _body_text = _body_text.replace(regexBodyBuffer, `$1INVALID`);
                        }
                    }

                    const _body_buffer = textToBuffer(_body_text);

                    const newRequestInit = {
                        // Change body
                        body: _body_buffer,
                    };

                    const newRequest = new Request(
                        request.url.toString(),
                        new Request(request, newRequestInit)
                    );

                    console.log(`Returning modified request.`);

                    return await fetch(newRequest);
                } else {
                    // Never log the body itself: it can hold passwords and other form fields.
                    console.log(`Unable to find an email match in a multipart body of ${_body.byteLength} bytes.`);
                }

                // Return original request untouched
                return await fetch(request);
            } else if (contentType === 'application/x-www-form-urlencoded') {
                // Method 1:
                // Try and extract the email from "normal inputs"
                // ==========================================================
                let _form = await request.clone().formData();

                const email = _form.get('email') || _form.get('your-email');

                if (email) {
                    console.log(`Found email input: ${email}`);

                    let validate = await validateEmail(email, clientIP);

                    await logValidation(event, email, pathname, validate);

                    if (validate.hasOwnProperty('status')) {
                        console.log(`Email validation status: ${validate.status}`);

                        if (typeof VALID_STATUS !== 'undefined' && !VALID_STATUS.includes(validate.status)) {
                            _form.set('email', `INVALID`);

                            const newRequestInit = {
                                // The incoming Content-Type header is carried
                                // over to the new request, so the body has to
                                // stay URL-encoded. Passing the FormData
                                // object straight through produces a
                                // multipart body that is still labelled
                                // application/x-www-form-urlencoded, which the
                                // origin cannot parse.
                                body: new URLSearchParams([..._form]).toString(),
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
                // Method 2:
                // Try and extract the email from the parsed body itself
                // This applies when the email input is not named accordignly (email)
                // ==========================================================
                else {
                    console.log(`Unable to find email input: ${email}`);

                    // Clone the request data as buffer
                    const _body = await request.clone().arrayBuffer();

                    let _body_text = decodeURIComponent(bufferToText(_body));

                    // Find the email
                    let m;
                    if ((m = regexFormBuffer.exec(_body_text)) !== null) {
                        const email = m[2];
                        console.log(`Matched email: ${email}`);

                        let validate = await validateEmail(email, clientIP);

                        await logValidation(event, email, pathname, validate);

                        if (validate.hasOwnProperty('status')) {
                            console.log(`Email validation status: ${validate.status}`);

                            if (typeof VALID_STATUS !== 'undefined' && !VALID_STATUS.includes(validate.status)) {
                                _body_text = _body_text.replace(regexFormBuffer, `$1INVALID`);
                            }
                        }

                        const _body_buffer = textToBuffer(_body_text);

                        const newRequestInit = {
                            body: _body_buffer,
                        };

                        const newRequest = new Request(
                            request.url.toString(),
                            new Request(request, newRequestInit)
                        );

                        console.log(`Returning modified request.`);

                        return await fetch(newRequest);
                    } else {
                        // Never log the body itself: it can hold passwords and other form fields.
                        console.log(`Unable to find an email match in a form body of ${_body.byteLength} bytes.`);
                    }
                }

                // Return original request untouched
                console.log(`Returning original request, nothing done.`);
                return await fetch(request);
            }
            // Experimental
            else if (contentType.includes('application/json')) {
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
