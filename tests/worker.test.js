/**
 * Offline tests for the ZeroBounce Cloudflare Worker.
 *
 * The Worker is a service-worker script: it has no exports and it reads its
 * configuration from globals that Cloudflare injects as environment bindings.
 * Each test therefore evaluates the source in a fresh `node:vm` context whose
 * globals are the bindings under test, which keeps module-level state (the
 * compiled regexes) from leaking between cases.
 *
 * `fetch` is always a fake. Nothing here touches the network or the live
 * ZeroBounce API, and the API key used below is a placeholder.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WORKER_PATH = path.join(__dirname, '..', 'cloudflare-worker-zerobounce.js');
const WORKER_SOURCE = fs.readFileSync(WORKER_PATH, 'utf8');

const API_KEY = 'test-api-key-placeholder';

/**
 * Evaluates the Worker in a fresh context.
 *
 * `bindings` are the Cloudflare environment bindings (API_KEY, API_REGION,
 * VALID_STATUS, BYPASS_PATH, ...). The returned object exposes the Worker's
 * top-level functions plus the recorded fetch calls.
 */
function loadWorker(bindings = {}, { validationResponse = { status: 'valid' }, unbind = [] } = {}) {
    const calls = { validation: [], forwarded: [] };
    const logs = [];
    const errors = [];

    const context = {
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        Request,
        Response,
        Headers,
        FormData,
        AbortSignal,
        Object,
        Array,
        JSON,
        Date,
        String,
        RegExp,
        console: {
            log: (message) => logs.push(String(message)),
            error: (message) => errors.push(String(message)),
        },
        // The Worker registers its fetch listener at the top level.
        addEventListener: () => {},
        fetch: async (input, init) => {
            if (input instanceof Request) {
                calls.forwarded.push(input);
                return new Response('origin response', { status: 200 });
            }

            calls.validation.push({ url: new URL(String(input)), init: init || {} });

            return new Response(JSON.stringify(validationResponse), {
                headers: { 'content-type': 'application/json' },
            });
        },
        API_TIMEOUT: 5000,
        ...bindings,
    };
    // A binding that is not set at all, as opposed to one set to undefined.
    for (const name of unbind) {
        delete context[name];
    }

    vm.createContext(context);
    vm.runInContext(WORKER_SOURCE, context);

    return { context, calls, logs, errors };
}

/** A minimal stand-in for the Cloudflare FetchEvent. */
function fetchEvent(request) {
    return {
        request,
        waitUntil: () => {},
        passThroughOnException: () => {},
    };
}

function formRequest(body, { url = 'https://example.com/subscribe', headers = {} } = {}) {
    return new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '198.51.100.7', ...headers },
        body,
    });
}

// ---------------------------------------------------------------------------
// Regional endpoint selection
// ---------------------------------------------------------------------------

test('validate goes to the global host when API_REGION is not bound', async () => {
    const { context, calls } = loadWorker({ API_KEY });

    await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.origin, 'https://api.zerobounce.net');
    assert.strictEqual(calls.validation[0].url.pathname, '/v2/validate');
});

test('API_REGION selects the regional validate host', async () => {
    const cases = [
        ['us', 'https://api-us.zerobounce.net'],
        ['usa', 'https://api-us.zerobounce.net'],
        ['eu', 'https://api-eu.zerobounce.net'],
        ['  EU  ', 'https://api-eu.zerobounce.net'],
        ['US', 'https://api-us.zerobounce.net'],
        ['global', 'https://api.zerobounce.net'],
        ['default', 'https://api.zerobounce.net'],
        ['', 'https://api.zerobounce.net'],
    ];

    for (const [region, expected] of cases) {
        const { context, calls } = loadWorker({ API_KEY, API_REGION: region });

        await context.validateEmail('test@example.com', '198.51.100.7');

        assert.strictEqual(calls.validation[0].url.origin, expected, `API_REGION=${JSON.stringify(region)}`);
        assert.strictEqual(calls.validation[0].url.pathname, '/v2/validate');
    }
});

test('an unknown API_REGION falls back to the global host and logs it', async () => {
    const { context, calls, logs } = loadWorker({ API_KEY, API_REGION: 'moon' });

    await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(calls.validation[0].url.origin, 'https://api.zerobounce.net');
    assert.ok(logs.some((line) => line.includes('Unknown API_REGION')), 'expected a fallback log line');
});

test('an inherited property name is not treated as a region', async () => {
    const { context, calls } = loadWorker({ API_KEY, API_REGION: 'constructor' });

    await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(calls.validation[0].url.origin, 'https://api.zerobounce.net');
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

test('the API key travels as the api_key query parameter, never as a header', async () => {
    const { context, calls } = loadWorker({ API_KEY });

    await context.validateEmail('test@example.com', '198.51.100.7');

    const { url, init } = calls.validation[0];

    assert.strictEqual(url.searchParams.get('api_key'), API_KEY);
    assert.strictEqual(url.searchParams.get('email'), 'test@example.com');
    assert.strictEqual(url.searchParams.get('ip_address'), '198.51.100.7');

    const headers = new Headers(init.headers || {});
    assert.strictEqual(headers.get('User-Agent'), 'ZeroBounce Email Validator (Cloudflare Worker)');
    for (const [, value] of headers) {
        assert.ok(!String(value).includes(API_KEY), 'the API key must not be sent in a header');
    }
});

test('no validation request is made when API_KEY is not bound', async () => {
    const { context, calls } = loadWorker({});

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(result, undefined);
    assert.strictEqual(calls.validation.length, 0);
});

test('a transport failure is reported as a JSON error payload', async () => {
    const { context } = loadWorker({ API_KEY });
    context.fetch = async () => {
        const error = new Error('connection reset');
        error.name = 'TypeError';
        throw error;
    };

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.doesNotThrow(() => JSON.parse(result));
    assert.deepStrictEqual(JSON.parse(result), { error: 'TypeError', message: 'connection reset' });
});

// ---------------------------------------------------------------------------
// The status allow-list (VALID_STATUS)
// ---------------------------------------------------------------------------

test('an allowed status forwards the original body untouched', async () => {
    const { context, calls } = loadWorker(
        { API_KEY, VALID_STATUS: ['valid', 'catch-all'] },
        { validationResponse: { status: 'valid' } }
    );

    await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.forwarded.length, 1);
    assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com&name=Test');
});

test('a status outside the allow-list replaces the address with INVALID', async () => {
    const { context, calls } = loadWorker(
        { API_KEY, VALID_STATUS: ['valid'] },
        { validationResponse: { status: 'spamtrap' } }
    );

    await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));

    const forwarded = calls.forwarded[0];

    // The Content-Type header is inherited from the incoming request, so the
    // rewritten body has to stay URL-encoded.
    assert.strictEqual(forwarded.headers.get('content-type'), 'application/x-www-form-urlencoded');

    const body = await forwarded.text();
    assert.strictEqual(new URLSearchParams(body).get('email'), 'INVALID');
    assert.strictEqual(new URLSearchParams(body).get('name'), 'Test');
    assert.ok(!body.includes('test%40example.com'), 'the rejected address must not reach the origin');
});

test('nothing is rewritten when VALID_STATUS is not bound', async () => {
    const { context, calls } = loadWorker({ API_KEY }, { validationResponse: { status: 'spamtrap' } });

    await context.handleRequest(fetchEvent(formRequest('email=test%40example.com')));

    assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com');
});

test('the allow-list also gates multipart bodies', async () => {
    const boundary = '----zbtestboundary';
    const multipart =
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="your-email"\r\n\r\n' +
        'test@example.com\r\n' +
        `--${boundary}--\r\n`;

    const { context, calls } = loadWorker(
        { API_KEY, VALID_STATUS: ['valid'] },
        { validationResponse: { status: 'spamtrap' } }
    );

    const request = new Request('https://example.com/subscribe', {
        method: 'POST',
        headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'CF-Connecting-IP': '198.51.100.7',
        },
        body: multipart,
    });

    await context.handleRequest(fetchEvent(request));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'test@example.com');

    const body = await calls.forwarded[0].text();
    assert.ok(body.includes('INVALID'), 'the multipart body should carry the INVALID marker');
    assert.ok(!body.includes('test@example.com'), 'the rejected address must not reach the origin');
});

// ---------------------------------------------------------------------------
// Pass-through paths
// ---------------------------------------------------------------------------

test('a BYPASS_PATH request is forwarded without being validated', async () => {
    const { context, calls } = loadWorker({ API_KEY, BYPASS_PATH: ['/subscribe'], VALID_STATUS: ['valid'] });

    await context.handleRequest(fetchEvent(formRequest('email=test%40example.com')));

    assert.strictEqual(calls.validation.length, 0);
    assert.strictEqual(calls.forwarded.length, 1);
});

test('a GET request is forwarded without being validated', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });

    await context.handleRequest(fetchEvent(new Request('https://example.com/subscribe')));

    assert.strictEqual(calls.validation.length, 0);
    assert.strictEqual(calls.forwarded.length, 1);
});

// ---------------------------------------------------------------------------
// Timeouts, redirects and failed validations
// ---------------------------------------------------------------------------

/** Records the timeout each validation request was given. */
function recordingAbortSignal(seen) {
    return {
        timeout: (ms) => {
            seen.push(ms);
            return AbortSignal.timeout(ms);
        },
    };
}

test('without an API_TIMEOUT binding the request still goes out, with a 10 s default timeout', async () => {
    const seen = [];
    const { context, calls } = loadWorker(
        { API_KEY, AbortSignal: recordingAbortSignal(seen) },
        { unbind: ['API_TIMEOUT'] }
    );

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(calls.validation.length, 1);
    assert.deepStrictEqual(seen, [10000]);
    assert.strictEqual(result.status, 'valid');
});

test('an API_TIMEOUT that is not a positive number falls back to the default and is logged', async () => {
    const seen = [];
    const { context, logs } = loadWorker({ API_KEY, API_TIMEOUT: 'soon', AbortSignal: recordingAbortSignal(seen) });

    await context.validateEmail('test@example.com', '198.51.100.7');

    assert.deepStrictEqual(seen, [10000]);
    assert.ok(logs.some((line) => line.includes('Invalid API_TIMEOUT')), 'expected a log line');
});

test('a validation request that times out is logged as an error and the form is forwarded untouched', async () => {
    const { context, calls, errors } = loadWorker({ API_KEY, API_TIMEOUT: 20, VALID_STATUS: ['valid'] });
    context.fetch = async (input, init) => {
        if (input instanceof Request) {
            calls.forwarded.push(input);
            return new Response('origin response');
        }
        calls.validation.push({ url: new URL(String(input)), init });
        // Never answers: only the timeout can end this request.
        return new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
        });
    };

    // AbortSignal.timeout() uses an unref'd timer, so while the fake fetch above waits
    // forever nothing keeps the event loop alive, and Node 22's test runner cancels the
    // test (and the rest of the file). Hold a ref'd timer for both timed-out requests.
    const keepAlive = setInterval(() => {}, 1000);
    try {
        const result = await context.validateEmail('test@example.com', '198.51.100.7');
        assert.strictEqual(JSON.parse(result).error, 'TimeoutError');
        assert.ok(errors.some((line) => line.includes('TimeoutError')), 'expected an error log line');

        await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));
        assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com&name=Test');
    } finally {
        clearInterval(keepAlive);
    }
});

test('the validation request does not follow redirects, and a 3xx answer is a logged failure', async () => {
    const { context, calls, errors } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    const followed = [];
    context.fetch = async (input, init) => {
        if (input instanceof Request) {
            calls.forwarded.push(input);
            return new Response('origin response');
        }
        const url = new URL(String(input));
        if (url.hostname !== 'api.zerobounce.net') followed.push(url);
        calls.validation.push({ url, init });
        return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/collect' } });
    };

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(calls.validation[0].init.redirect, 'manual');
    assert.strictEqual(followed.length, 0);
    assert.deepStrictEqual(JSON.parse(result).error, 'Redirect');
    assert.ok(errors.some((line) => line.includes('HTTP 302')), 'expected an error log line');
    assert.ok(errors.every((line) => !line.includes(API_KEY)), 'the API key must not be logged');
});

test('a dead key is logged as an error and the submission is forwarded unvalidated', async () => {
    const message = 'Invalid API key or your account ran out of credits';
    const { context, calls, errors } = loadWorker(
        { API_KEY, VALID_STATUS: ['valid'] },
        { validationResponse: { error: message } }
    );

    await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com&name=Test');
    assert.ok(errors.some((line) => line.includes(message)), 'expected the API message in an error log line');
    assert.ok(errors.every((line) => !line.includes(API_KEY)), 'the API key must not be logged');
});

for (const [name, body] of [
    ['an error string beside a status', { status: 'unknown', error: 'Invalid API key or your account ran out of credits' }],
    ['an error_message beside a status', { status: 'invalid', error_message: 'Invalid API key' }],
    ['an Error beside a status', { status: 'invalid', Error: 'Invalid API key' }],
    ['success false beside a status', { success: false, status: 'error', message: 'Invalid API key' }],
    ['success "false" beside a status', { success: 'false', status: 'invalid', message: 'Invalid API key' }],
    ['success "False" beside a status', { success: 'False', status: 'invalid', message: 'Invalid API key' }],
]) {
    test(`a 2xx with ${name} is an API error: logged, and the address is forwarded unchanged`, async () => {
        const { context, calls, errors } = loadWorker(
            { API_KEY, VALID_STATUS: ['valid'] },
            { validationResponse: body }
        );

        await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));

        assert.strictEqual(calls.validation.length, 1);
        assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com&name=Test');
        assert.ok(errors.some((line) => line.includes('Invalid API key')), 'expected the API message in an error log line');
    });
}

test('a 2xx validation result with an empty error field is still a result', async () => {
    const { context } = loadWorker({ API_KEY }, { validationResponse: { status: 'invalid', error: '', success: true } });

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.status, 'invalid');
});

test('ip_address is left out when the CF-Connecting-IP header is missing', async () => {
    const { context, calls } = loadWorker({ API_KEY });

    await context.validateEmail('test@example.com', null);

    assert.strictEqual(calls.validation[0].url.searchParams.has('ip_address'), false);
});

test('a body without a recognisable address is not written to the log', async () => {
    const secret = 'hunter2-not-a-real-password';
    const { context, calls, logs } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });

    await context.handleRequest(fetchEvent(formRequest(`user=someone&password=${secret}`)));

    const boundary = '----zbtestboundary';
    const multipart =
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="password"\r\n\r\n' +
        `${secret}\r\n` +
        `--${boundary}--\r\n`;
    await context.handleRequest(fetchEvent(new Request('https://example.com/login', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: multipart,
    })));

    assert.strictEqual(calls.validation.length, 0);
    assert.strictEqual(calls.forwarded.length, 2);
    assert.ok(logs.every((line) => !line.includes(secret)), 'a form body must never be logged');
});

test('a transport error message with quotes still yields valid JSON', async () => {
    const { context } = loadWorker({ API_KEY });
    context.fetch = async () => {
        throw new TypeError('unexpected token "<" in "body"');
    };

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.deepStrictEqual(JSON.parse(result), { error: 'TypeError', message: 'unexpected token "<" in "body"' });
});

// ---------------------------------------------------------------------------
// URL-encoded bodies reach the origin byte for byte
// ---------------------------------------------------------------------------

test('a form whose address field has another name is forwarded byte for byte when the address is accepted', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'valid' } });
    const sent = 'contact=john%40example.com&note=a%26b%3Dc&pw=p%2Bq%25&greeting=hello+world';

    await context.handleRequest(fetchEvent(formRequest(sent)));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'john@example.com');
    assert.strictEqual(await calls.forwarded[0].text(), sent);
});

test('a rejected address in a field with another name becomes INVALID and nothing else changes', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('contact=john%40example.com&note=a%26b%3Dc&x=1')));

    const body = await calls.forwarded[0].text();
    assert.strictEqual(body, 'contact=INVALID&note=a%26b%3Dc&x=1');
    assert.deepStrictEqual([...new URLSearchParams(body)], [['contact', 'INVALID'], ['note', 'a&b=c'], ['x', '1']]);
});

test('an address in the last field is validated and rewritten too', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('name=T&contact=john%40example.com')));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(await calls.forwarded[0].text(), 'name=T&contact=INVALID');
});

test('malformed percent-encoding elsewhere in the form does not skip validation', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('contact=john%40example.com&x=%E0%A4%A&y=1')));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'john@example.com');
    assert.strictEqual(await calls.forwarded[0].text(), 'contact=INVALID&x=%E0%A4%A&y=1');
});

test('a rejected your-email address is itself rewritten, and no extra email field is added', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('your-email=bad%40example.com&name=T%26C')));

    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'bad@example.com');
    assert.strictEqual(await calls.forwarded[0].text(), 'your-email=INVALID&name=T%26C');
});

test('a rejected email field is rewritten in place and the other fields keep their encoding', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('name=Jo%20Doe&email=bad%40example.com&email=other%40example.com&n=%7E')));

    assert.strictEqual(await calls.forwarded[0].text(), 'name=Jo%20Doe&email=INVALID&email=INVALID&n=%7E');
});

// ---------------------------------------------------------------------------
// A malformed API_KEY binding
// ---------------------------------------------------------------------------

test('an API_KEY with whitespace or control characters is refused and logged, and no request is made', async () => {
    for (const badKey of [`${API_KEY}\n`, ` ${API_KEY}`, `${API_KEY}\t`, `${API_KEY}\u0000x`, `${API_KEY}\u007f`, 'two words', '']) {
        const { context, calls, errors } = loadWorker({ API_KEY: badKey, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

        await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));

        assert.strictEqual(calls.validation.length, 0, `no request for ${JSON.stringify(badKey)}`);
        assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com&name=Test');
        assert.ok(errors.some((line) => line.includes('API_KEY')), `expected an error log line for ${JSON.stringify(badKey)}`);
        assert.ok(errors.every((line) => !line.includes(API_KEY)), 'the API key must not be logged');
    }
});

// ---------------------------------------------------------------------------
// Multipart bodies reach the origin byte for byte
// ---------------------------------------------------------------------------

/** Bytes that are not valid UTF-8 (a JPEG header and stray continuation bytes). */
const BINARY_FILE = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x80, 0x81, 0xfe, 0xc0, 0x0d, 0x0a, 0xc3]);

function concatBytes(...parts) {
    const chunks = parts.map((part) => (typeof part === 'string' ? new TextEncoder().encode(part) : part));
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** A multipart body with an address field between two binary file parts. */
function multipartWithFiles(boundary, address) {
    const filePart = (name) => concatBytes(
        `--${boundary}\r\n`,
        `Content-Disposition: form-data; name="${name}"; filename="${name}.jpg"\r\n`,
        'Content-Type: image/jpeg\r\n\r\n',
        BINARY_FILE,
        '\r\n'
    );
    return concatBytes(
        filePart('before'),
        `--${boundary}\r\n`,
        'Content-Disposition: form-data; name="email"\r\n\r\n',
        `${address}\r\n`,
        filePart('after'),
        `--${boundary}--\r\n`
    );
}

function multipartRequest(body, contentType) {
    return new Request('https://example.com/upload', {
        method: 'POST',
        headers: { 'content-type': contentType, 'CF-Connecting-IP': '198.51.100.7' },
        body,
    });
}

test('a multipart body with binary file parts is forwarded byte for byte when the address is accepted', async () => {
    const boundary = '----zbtestboundary';
    const sent = multipartWithFiles(boundary, 'person@example.com');
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'valid' } });

    await context.handleRequest(fetchEvent(multipartRequest(sent, `multipart/form-data; boundary=${boundary}`)));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'person@example.com');
    assert.deepStrictEqual(new Uint8Array(await calls.forwarded[0].arrayBuffer()), sent);
});

test('a rejected multipart address becomes INVALID and the binary file parts are untouched', async () => {
    const boundary = '----zbtestboundary';
    const sent = multipartWithFiles(boundary, 'person@example.com');
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

    await context.handleRequest(fetchEvent(multipartRequest(sent, `multipart/form-data; boundary=${boundary}`)));

    assert.strictEqual(calls.validation.length, 1);
    const forwarded = new Uint8Array(await calls.forwarded[0].arrayBuffer());
    assert.deepStrictEqual(forwarded, multipartWithFiles(boundary, 'INVALID'));
    assert.strictEqual(calls.forwarded[0].headers.get('content-type'), `multipart/form-data; boundary=${boundary}`);
});

test('an address inside a file part is neither validated nor rewritten', async () => {
    const boundary = 'zb';
    const sent = concatBytes(
        `--${boundary}\r\n`,
        'Content-Disposition: form-data; name="upload"; filename="contacts.txt"\r\n',
        'Content-Type: text/plain; charset="utf-8"\r\n\r\n',
        'someone@example.com\r\n',
        `--${boundary}--\r\n`
    );
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

    await context.handleRequest(fetchEvent(multipartRequest(sent, `multipart/form-data; boundary=${boundary}`)));

    assert.strictEqual(calls.validation.length, 0);
    assert.deepStrictEqual(new Uint8Array(await calls.forwarded[0].arrayBuffer()), sent);
});

// ---------------------------------------------------------------------------
// Content-Type is matched on its media type, not on the exact header text
// ---------------------------------------------------------------------------

test('a URL-encoded form is validated whatever the case of its media type and whatever its parameters', async () => {
    for (const contentType of [
        'application/x-www-form-urlencoded',
        'application/x-www-form-urlencoded; charset=UTF-8',
        'Application/X-WWW-Form-URLEncoded;charset=utf-8',
    ]) {
        const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

        await context.handleRequest(fetchEvent(formRequest('name=A&email=bad%40example.com', { headers: { 'content-type': contentType } })));

        assert.strictEqual(calls.validation.length, 1, contentType);
        assert.strictEqual(await calls.forwarded[0].text(), 'name=A&email=INVALID', contentType);
    }
});

test('a multipart form is validated whatever the case of its media type and however its boundary is written', async () => {
    const boundary = 'zb-boundary';
    for (const contentType of [
        `multipart/form-data; boundary=${boundary}`,
        `Multipart/Form-Data; Boundary="${boundary}"`,
        `multipart/form-data;charset=UTF-8;boundary=${boundary}`,
    ]) {
        const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

        await context.handleRequest(fetchEvent(multipartRequest(multipartWithFiles(boundary, 'person@example.com'), contentType)));

        assert.strictEqual(calls.validation.length, 1, contentType);
        assert.deepStrictEqual(new Uint8Array(await calls.forwarded[0].arrayBuffer()), multipartWithFiles(boundary, 'INVALID'), contentType);
    }
});

test('a media type that merely contains a form type is not treated as one', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('email=bad%40example.com', { headers: { 'content-type': 'text/plain; note="application/x-www-form-urlencoded"' } })));

    assert.strictEqual(calls.validation.length, 0);
    assert.strictEqual(await calls.forwarded[0].text(), 'email=bad%40example.com');
});

// ---------------------------------------------------------------------------
// Field selection and key redaction
// ---------------------------------------------------------------------------

test('a your-email field is validated ahead of an earlier field that also holds an address', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('contact=other%40example.com&your-email=bad%40example.com')));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'bad@example.com');
    assert.strictEqual(await calls.forwarded[0].text(), 'contact=other%40example.com&your-email=INVALID');
});

test('an error message carrying the API key is redacted in the log and in the returned payload', async () => {
    // A key with characters that URL encoding changes, so both forms are checked.
    const key = 'test/key+placeholder=1';
    const encoded = encodeURIComponent(key);
    const { context, errors } = loadWorker({ API_KEY: key });
    context.fetch = async () => {
        throw new TypeError(`fetch failed: key ${key} in https://api.zerobounce.net/v2/validate?api_key=${encoded}&email=x`);
    };

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.ok(errors.length > 0, 'expected an error log line');
    for (const text of [result, ...errors]) {
        assert.ok(!text.includes(key), `the raw key leaked: ${text}`);
        assert.ok(!text.includes(encoded), `the encoded key leaked: ${text}`);
    }
    assert.match(JSON.parse(result).message, /api_key=\*\*\*&email=x/);
});

test('a JSON-escaped copy of the API key in an error message is redacted in the log and in the returned payload', async () => {
    // A key with a quote, a slash, a plus and a percent sign: its JSON-escaped
    // forms differ from the raw and the URL-encoded one.
    const key = 'test"key/+%1';
    const json = JSON.stringify(key).slice(1, -1);
    const forms = [key, encodeURIComponent(key), json, json.replace(/\//g, '\\/')];
    assert.strictEqual(new Set(forms).size, forms.length);
    const { context, errors } = loadWorker({ API_KEY: key });
    // A server quoting a JSON copy of the request inside its error string.
    context.fetch = async () => jsonResponse(200, { error: `Invalid API key in ${forms.join(' ')}` });

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.ok(errors.length > 0, 'expected an error log line');
    for (const text of [JSON.parse(result).message, ...errors]) {
        for (const form of forms) {
            assert.ok(!text.includes(form), `the key leaked as ${form}: ${text}`);
        }
    }
});

test('the API key is redacted in each of its forms, URL-encoded JSON-escaped included, needing every one', async () => {
    // A quote, "/", "+", "%", "&", "=", "<", ">", "'" and "\\" (the Worker
    // refuses a key with whitespace): every form below differs from every other.
    const key = `key"/+%&=<>'\\z`;
    const json = JSON.stringify(key).slice(1, -1);
    const form = (text) => new URLSearchParams({ s: text }).toString().slice(2);
    const bases = {
        raw: key,
        json,
        'json, / as \\/': json.replace(/\//g, '\\/'),
        'json twice': JSON.stringify(json).slice(1, -1),
    };
    const forms = {};
    for (const [name, base] of Object.entries(bases)) {
        forms[name] = base;
        forms[`${name}, URL-encoded`] = encodeURIComponent(base);
        forms[`${name}, form-encoded`] = form(base);
    }
    assert.strictEqual(new Set(Object.values(forms)).size, Object.keys(forms).length);
    const { context } = loadWorker({ API_KEY: key });
    const messageFor = async (echo) => {
        context.fetch = async () => jsonResponse(200, { error: `Invalid API key [${echo}]` });
        return JSON.parse(await context.validateEmail('test@example.com', '198.51.100.7')).message;
    };
    // Each form, echoed on its own, must come back exactly as "***" would: a
    // form left out leaks, or leaves the tail of a longer form behind.
    const expected = await messageFor('***');
    assert.ok(expected.includes('[***]'), expected);
    const got = {};
    for (const [name, echo] of Object.entries(forms)) {
        got[name] = await messageFor(echo);
    }
    assert.deepStrictEqual(got, Object.fromEntries(Object.keys(forms).map((name) => [name, expected])));
});

test('a 2xx answer served as text/html is not a validation result, though its body parses', async () => {
    const { context, errors } = loadWorker({ API_KEY });
    const body = JSON.stringify({ status: 'invalid', address: 'test@example.com' });
    // The same body as JSON is a result, so only the content type tells them apart.
    context.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    assert.deepStrictEqual(await context.validateEmail('test@example.com', '198.51.100.7'), JSON.parse(body));

    context.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(typeof result, 'string', 'a failure payload, not a validation result');
    assert.strictEqual(JSON.parse(result).error, 'HTTP 200');
    assert.ok(errors.some((line) => line.includes('HTTP 200')));
});

// ---------------------------------------------------------------------------
// API errors fail open, and nothing stored or logged carries the key
// ---------------------------------------------------------------------------

/**
 * Every way the validation request can fail. `respond(url)` answers the
 * validation request; `url` is the full request URL, query string and key
 * included, so a body can quote it the way a proxy or an error page might.
 */
const KEY_WITH_ENCODING = 'test/key+placeholder=1';
const FAILURE_MODES = [
    { name: '200 dead key quoting the key', respond: () => jsonResponse(200, { error: `Invalid API key ${KEY_WITH_ENCODING}` }) },
    { name: '200 error quoting the request URL', respond: (url) => jsonResponse(200, { error: `Invalid API key for ${url}` }) },
    { name: '200 success:false quoting the key', respond: () => jsonResponse(200, { success: false, message: `Rejected ${KEY_WITH_ENCODING}` }) },
    { name: '200 object without status or message', respond: () => jsonResponse(200, { key: KEY_WITH_ENCODING }) },
    { name: '200 body that is not JSON', respond: (url) => new Response(`oops ${url}`, { status: 200 }) },
    { name: '400 text/plain quoting the request URL', status: 400, respond: (url) => new Response(`Bad request: ${url}`, { status: 400, headers: { 'content-type': 'text/plain' } }) },
    { name: '400 JSON error quoting the key', status: 400, respond: () => jsonResponse(400, { error: `Invalid API key ${KEY_WITH_ENCODING}` }) },
    { name: '500 JSON with a status field', status: 500, respond: () => jsonResponse(500, { status: 'error', message: `Internal error for ${KEY_WITH_ENCODING}` }) },
    { name: '429 problem JSON with a numeric status', status: 429, respond: (url) => jsonResponse(429, { status: 429, title: 'Too Many Requests', detail: url }) },
    { name: '403 JSON with a validation-looking status', status: 403, respond: () => jsonResponse(403, { status: 'invalid', error: 'Forbidden' }) },
    { name: '503 HTML page', status: 503, respond: (url) => new Response(`<html><title>Down</title>${url}</html>`, { status: 503, headers: { 'content-type': 'text/html' } }) },
    { name: '302 redirect', status: 302, respond: (url) => new Response(null, { status: 302, headers: { location: `https://elsewhere.example/?from=${encodeURIComponent(url)}` } }) },
    { name: 'transport error quoting the request URL', respond: (url) => { throw new TypeError(`fetch failed for ${url} (${KEY_WITH_ENCODING})`); } },
];

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function recordingKv() {
    const puts = [];
    return { puts, LOGS: { put: async (key, value) => { puts.push({ key, value }); } } };
}

for (const mode of FAILURE_MODES) {
    test(`fails open and keeps the key out of KV and the logs: ${mode.name}`, async () => {
        const kv = recordingKv();
        const { context, calls, errors, logs } = loadWorker({ API_KEY: KEY_WITH_ENCODING, VALID_STATUS: ['valid'], LOGS: kv.LOGS });
        context.fetch = async (input) => {
            if (input instanceof Request) {
                calls.forwarded.push(input);
                return new Response('origin response');
            }
            return mode.respond(String(input));
        };

        await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));

        // Fail open: the submission reaches the origin unvalidated, never rewritten to INVALID.
        assert.strictEqual(calls.forwarded.length, 1);
        assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com&name=Test');

        // ... and the failure is logged as one, naming the HTTP status where there is one.
        assert.ok(errors.some((line) => line.startsWith('ZeroBounce validation failed')), `expected an error log line, got ${JSON.stringify(errors)}`);
        if (mode.status) {
            assert.ok(errors.some((line) => line.includes(`HTTP ${mode.status}`)), `expected HTTP ${mode.status} in ${JSON.stringify(errors)}`);
        }

        // What is stored in KV is the failure payload, not the API's raw body.
        assert.strictEqual(kv.puts.length, 1);
        const stored = JSON.parse(JSON.parse(kv.puts[0].value));
        assert.deepStrictEqual(Object.keys(stored).sort(), ['error', 'message']);

        const encoded = encodeURIComponent(KEY_WITH_ENCODING);
        for (const text of [...kv.puts.map((p) => p.key + p.value), ...errors, ...logs]) {
            assert.ok(!text.includes(KEY_WITH_ENCODING), `the raw key leaked: ${text}`);
            assert.ok(!text.includes(encoded), `the encoded key leaked: ${text}`);
        }
    });
}

test('a non-2xx answer is an API error even when its body has a validation status', async () => {
    const { context, errors } = loadWorker({ API_KEY }, { });
    context.fetch = async () => jsonResponse(500, { status: 'invalid', message: 'Internal' });

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(typeof result, 'string', 'a failure payload, not a validation result');
    assert.deepStrictEqual(JSON.parse(result), { error: 'HTTP 500', message: 'Internal' });
    assert.ok(errors.some((line) => line.includes('HTTP 500') && line.includes('Internal')));
});

test('a validation result is stored in KV with the key redacted wherever it appears', async () => {
    const kv = recordingKv();
    const { context } = loadWorker(
        { API_KEY: KEY_WITH_ENCODING, VALID_STATUS: ['valid'], LOGS: kv.LOGS },
        { validationResponse: { status: 'valid', address: 'test@example.com', note: `seen ${KEY_WITH_ENCODING}` } }
    );

    await context.handleRequest(fetchEvent(formRequest('email=test%40example.com')));

    assert.strictEqual(kv.puts.length, 1);
    const stored = JSON.parse(kv.puts[0].value);
    assert.strictEqual(stored.status, 'valid');
    assert.strictEqual(stored.note, 'seen ***');
});
