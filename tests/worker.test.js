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
