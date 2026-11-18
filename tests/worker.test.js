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
function loadWorker(bindings = {}, { validationResponse = { address: 'test@example.com', status: 'valid' }, unbind = [] } = {}) {
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

            // A Uint8Array answers with those exact bytes (for a body that is not UTF-8).
            return new Response(validationResponse instanceof Uint8Array ? validationResponse : JSON.stringify(validationResponse), {
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

test('no validation request is made when API_KEY is not bound, and the failure is returned, not thrown', async () => {
    const { context, calls, errors } = loadWorker({});

    const result = await context.validateEmail('test@example.com', '198.51.100.7');

    assert.strictEqual(JSON.parse(result).error, 'Missing API_KEY');
    assert.ok(errors.some((line) => line.includes('API_KEY')));
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
        { validationResponse: { address: 'test@example.com', status: 'valid' } }
    );

    await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.forwarded.length, 1);
    assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com&name=Test');
});

test('a status outside the allow-list replaces the address with INVALID', async () => {
    const { context, calls } = loadWorker(
        { API_KEY, VALID_STATUS: ['valid'] },
        { validationResponse: { address: 'test@example.com', status: 'spamtrap' } }
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
    const { context, calls } = loadWorker({ API_KEY }, { validationResponse: { address: 'test@example.com', status: 'spamtrap' } });

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
        { validationResponse: { address: 'test@example.com', status: 'spamtrap' } }
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
    ['success "FALSE" beside a status', { success: 'FALSE', status: 'valid', address: 'a@b.c', message: 'Invalid API key' }],
    ['success 0 beside a status', { success: 0, status: 'valid', address: 'a@b.c', message: 'Invalid API key' }],
    ['success 0.0 beside a status', { success: 0.0, status: 'valid', address: 'a@b.c', message: 'Invalid API key' }],
    ['success "0" beside a status', { success: '0', status: 'valid', address: 'a@b.c', message: 'Invalid API key' }],
    ['success " false " beside a status', { success: ' false ', status: 'valid', address: 'a@b.c', message: 'Invalid API key' }],
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

test('a real true flag or a non-flag beside a status stays a validation result', async () => {
    for (const success of [true, 1, 1.0, '1', 'TRUE', ' true ', 'x', 0.4, 5, '']) {
        const { context, calls, errors } = loadWorker(
            { API_KEY, VALID_STATUS: ['valid'] },
            { validationResponse: { address: 'test@example.com', status: 'invalid', success } }
        );
        await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));
        assert.strictEqual(await calls.forwarded[0].text(), 'email=INVALID&name=Test', `success ${JSON.stringify(success)} is a result`);
        assert.ok(errors.every((line) => !line.includes('validation failed')), `success ${JSON.stringify(success)} is not an API error`);
    }
});

// Field types are part of the shape (check E7): a validation result has
// address and status as strings. Anything else on a 2xx is an API error with
// HTTP 200, so the Worker fails open instead of rewriting the address.
for (const [name, body] of [
    ['a numeric status', { address: 'test@example.com', status: 1 }],
    ['a null status', { address: 'test@example.com', status: null, sub_status: '' }],
    ['a boolean status', { address: 'test@example.com', status: false }],
    ['an object status', { address: 'test@example.com', status: {} }],
    ['an array status', { address: 'test@example.com', status: ['invalid'] }],
    ['a numeric address', { address: 5, status: 'invalid' }],
    ['a null address', { address: null, status: 'invalid' }],
    ['no address', { status: 'invalid' }],
]) {
    test(`a 2xx with ${name} is an API error with HTTP 200: logged, and the address is forwarded unchanged`, async () => {
        const { context, calls, errors } = loadWorker(
            { API_KEY, VALID_STATUS: ['valid'] },
            { validationResponse: body }
        );

        const result = await context.validateEmail('test@example.com', '198.51.100.7');
        assert.strictEqual(typeof result, 'string', JSON.stringify(result));
        assert.strictEqual(JSON.parse(result).error, 'HTTP 200');

        await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));
        assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com&name=Test');
        assert.ok(errors.length > 0, 'expected an error log line');
    });
}

test('the documented validate examples, with their null and empty fields, are still results', async () => {
    for (const body of [
        {
            address: 'valid@example.com', status: 'valid', sub_status: '', free_email: false, did_you_mean: null,
            account: null, domain: null, domain_age_days: '9692', smtp_provider: 'example', mx_found: 'true',
            mx_record: 'mx.example.com', firstname: 'zero', lastname: 'bounce', gender: 'male', country: 'United States',
            region: 'Florida', city: 'West Palm Beach', zipcode: '33401', processed_at: '2023-03-23 13:30:28.105',
        },
        { address: 'invalid@example.com', status: 'invalid', sub_status: 'failed_syntax_check', account: '', mx_record: null },
    ]) {
        const { context } = loadWorker({ API_KEY }, { validationResponse: body });
        const result = await context.validateEmail('test@example.com', '198.51.100.7');
        assert.strictEqual(typeof result, 'object', JSON.stringify(body));
        assert.strictEqual(result.status, body.status);
    }
});

test('a 2xx validation result with an empty error field is still a result', async () => {
    const { context } = loadWorker({ API_KEY }, { validationResponse: { address: 'test@example.com', status: 'invalid', error: '', success: true } });

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
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'valid' } });
    const sent = 'contact=john%40example.com&note=a%26b%3Dc&pw=p%2Bq%25&greeting=hello+world';

    await context.handleRequest(fetchEvent(formRequest(sent)));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'john@example.com');
    assert.strictEqual(await calls.forwarded[0].text(), sent);
});

test('a rejected address in a field with another name becomes INVALID and nothing else changes', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('contact=john%40example.com&note=a%26b%3Dc&x=1')));

    const body = await calls.forwarded[0].text();
    assert.strictEqual(body, 'contact=INVALID&note=a%26b%3Dc&x=1');
    assert.deepStrictEqual([...new URLSearchParams(body)], [['contact', 'INVALID'], ['note', 'a&b=c'], ['x', '1']]);
});

test('an address in the last field is validated and rewritten too', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('name=T&contact=john%40example.com')));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(await calls.forwarded[0].text(), 'name=T&contact=INVALID');
});

test('malformed percent-encoding elsewhere in the form does not skip validation', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('contact=john%40example.com&x=%E0%A4%A&y=1')));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'john@example.com');
    assert.strictEqual(await calls.forwarded[0].text(), 'contact=INVALID&x=%E0%A4%A&y=1');
});

test('a rejected your-email address is itself rewritten, and no extra email field is added', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('your-email=bad%40example.com&name=T%26C')));

    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'bad@example.com');
    assert.strictEqual(await calls.forwarded[0].text(), 'your-email=INVALID&name=T%26C');
});

test('a rejected email field is rewritten in place and the other fields keep their encoding', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('name=Jo%20Doe&email=bad%40example.com&email=other%40example.com&n=%7E')));

    assert.strictEqual(await calls.forwarded[0].text(), 'name=Jo%20Doe&email=INVALID&email=INVALID&n=%7E');
});

// ---------------------------------------------------------------------------
// A malformed API_KEY binding
// ---------------------------------------------------------------------------

test('an API_KEY with whitespace or control characters is refused and logged, and no request is made', async () => {
    for (const badKey of [`${API_KEY}\n`, ` ${API_KEY}`, `${API_KEY}\t`, `${API_KEY}\u0000x`, `${API_KEY}\u007f`, 'two words', '', `${API_KEY}\u202E`, `${API_KEY}\u200B`, `${API_KEY}\u2066`, `${API_KEY}\u00AD`, `${API_KEY}\u180E`, `${API_KEY}\u0600`, `${API_KEY}\u0890`, `${API_KEY}\u0891`, `${API_KEY}\uFFF9`, `${API_KEY}\u{1D173}`]) {
        const { context, calls, errors } = loadWorker({ API_KEY: badKey, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

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
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'valid' } });

    await context.handleRequest(fetchEvent(multipartRequest(sent, `multipart/form-data; boundary=${boundary}`)));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'person@example.com');
    assert.deepStrictEqual(new Uint8Array(await calls.forwarded[0].arrayBuffer()), sent);
});

test('a rejected multipart address becomes INVALID and the binary file parts are untouched', async () => {
    const boundary = '----zbtestboundary';
    const sent = multipartWithFiles(boundary, 'person@example.com');
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

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
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

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
        const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

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
        const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

        await context.handleRequest(fetchEvent(multipartRequest(multipartWithFiles(boundary, 'person@example.com'), contentType)));

        assert.strictEqual(calls.validation.length, 1, contentType);
        assert.deepStrictEqual(new Uint8Array(await calls.forwarded[0].arrayBuffer()), multipartWithFiles(boundary, 'INVALID'), contentType);
    }
});

test('a media type that merely contains a form type is answered 400 (ambiguous), with no API or origin call', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

    const response = await context.handleRequest(fetchEvent(formRequest('email=bad%40example.com', { headers: { 'content-type': 'text/plain; note="application/x-www-form-urlencoded"' } })));

    assert.strictEqual(response.status, 400);
    assert.strictEqual(calls.validation.length, 0);
    assert.strictEqual(calls.forwarded.length, 0);
});

// ---------------------------------------------------------------------------
// Field selection and key redaction
// ---------------------------------------------------------------------------

test('a your-email field is validated ahead of an earlier field that also holds an address', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

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

test('the API key is redacted in every composed form (JSON-escaped up to twice, with and without \\/, URL- and form-encoded), needing every one', async () => {
    // A quote, "/", "+", "%", "&", "=", "<", ">", "'" and "\\" (the Worker
    // refuses a key with whitespace, so no space): every form differs.
    const key = `key"/+%&=<>'\\z`;
    // Composed here from the encoders, independently of the Worker's list.
    const quotings = {
        'JSON-escaped': (text) => JSON.stringify(text).slice(1, -1),
        'JSON-escaped, / as \\/': (text) => JSON.stringify(text).slice(1, -1).replace(/\//g, '\\/'),
    };
    const encodings = {
        '': (text) => text,
        ', URL-encoded (%20)': (text) => encodeURIComponent(text),
        ', form-encoded (+)': (text) => new URLSearchParams({ s: text }).toString().slice(2),
    };
    const quoted = { raw: key };
    for (const [first, once] of Object.entries(quotings)) {
        quoted[first] = once(key);
        for (const [second, twice] of Object.entries(quotings)) {
            quoted[`${first}, then ${second}`] = twice(once(key));
        }
    }
    const forms = {};
    for (const [quoting, text] of Object.entries(quoted)) {
        for (const [encoding, encode] of Object.entries(encodings)) {
            forms[`${quoting}${encoding}`] = encode(text);
        }
    }
    assert.strictEqual(Object.keys(forms).length, 21);
    assert.strictEqual(new Set(Object.values(forms)).size, 21);
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
    { name: '200 body that is not JSON', status: 200, respond: (url) => new Response(`oops ${url}`, { status: 200 }) },
    { name: '200 CSV under application/json', status: 200, respond: (url) => new Response(`email,status\n${url},valid\n`, { status: 200, headers: { 'content-type': 'application/json' } }) },
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
        // One JSON object text, not a JSON string holding JSON.
        const stored = JSON.parse(kv.puts[0].value);
        assert.strictEqual(typeof stored, 'object');
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

test('a 4xx or 5xx whose body looks like a validation result (string status and address, no error) is an API error, and the form is forwarded unchanged', async () => {
    const resultBody = { address: 'test@example.com', status: 'invalid', sub_status: 'mailbox_not_found' };
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
        const { context, calls, errors } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
        context.fetch = async (input) => {
            if (input instanceof Request) {
                calls.forwarded.push(input);
                return new Response('origin response');
            }
            return jsonResponse(status, resultBody);
        };

        const result = await context.validateEmail('test@example.com', '198.51.100.7');
        assert.strictEqual(typeof result, 'string', `HTTP ${status}: a failure payload, not a validation result`);
        assert.strictEqual(JSON.parse(result).error, `HTTP ${status}`);

        errors.length = 0;
        await context.handleRequest(fetchEvent(formRequest('email=test%40example.com&name=Test')));
        // Fail open: an "invalid" status on an error answer must not rewrite the address.
        assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com&name=Test', `HTTP ${status}`);
        assert.ok(errors.some((line) => line.includes(`HTTP ${status}`)), `HTTP ${status}: ${JSON.stringify(errors)}`);
    }
});

test('a validation result is stored in KV with the key redacted wherever it appears', async () => {
    const kv = recordingKv();
    const { context } = loadWorker(
        { API_KEY: KEY_WITH_ENCODING, VALID_STATUS: ['valid'], LOGS: kv.LOGS },
        { validationResponse: { address: 'test@example.com', status: 'valid', address: 'test@example.com', note: `seen ${KEY_WITH_ENCODING}` } }
    );

    await context.handleRequest(fetchEvent(formRequest('email=test%40example.com')));

    assert.strictEqual(kv.puts.length, 1);
    const stored = JSON.parse(kv.puts[0].value);
    assert.strictEqual(stored.status, 'valid');
    assert.strictEqual(stored.note, 'seen ***');
});

// ---------------------------------------------------------------------------
// Strict JSON (check E7): the shared corpus
// ---------------------------------------------------------------------------

/**
 * tests/fixtures/strict-json-corpus.tsv is a byte-identical copy of
 * sdk-docs/skills/zerobounce-sdk/references/strict-json-corpus.tsv in
 * zerobounce/sdk-docs: copy it over, never edit it here. Each line is
 * VERDICT<TAB>"JSON-encoded body"; "#" lines are comments.
 */
function strictJsonCorpus() {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'strict-json-corpus.tsv'), 'utf8');
    const corpus = { REJECT: [], ACCEPT: [] };
    for (const line of text.split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const tab = line.indexOf('\t');
        const verdict = line.slice(0, tab);
        assert.ok(verdict in corpus, `unknown verdict ${verdict}`);
        corpus[verdict].push(JSON.parse(line.slice(tab + 1)));
    }
    return corpus;
}

test('every REJECT body of the strict JSON corpus is a "not JSON" failure with HTTP 200, and every ACCEPT body parses', async () => {
    const corpus = strictJsonCorpus();
    assert.ok(corpus.REJECT.length > 30 && corpus.ACCEPT.length > 5);
    const { context } = loadWorker({ API_KEY });
    const notJson = { error: 'HTTP 200', message: 'ZeroBounce returned a response that is not JSON' };
    const wrong = [];
    for (const [verdict, bodies] of Object.entries(corpus)) {
        for (const body of bodies) {
            context.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
            const result = await context.validateEmail('test@example.com', '198.51.100.7');
            const rejected = typeof result === 'string' && JSON.stringify(JSON.parse(result)) === JSON.stringify(notJson);
            if (rejected !== (verdict === 'REJECT')) {
                wrong.push(`${verdict} ${JSON.stringify(body)}: ${typeof result === 'string' ? result : JSON.stringify(result)}`);
            }
        }
    }
    assert.deepStrictEqual(wrong, []);
});

// ---------------------------------------------------------------------------
// Redaction closed under encoding (checks S4/S7)
// ---------------------------------------------------------------------------

/**
 * A key echoed through any sequence of up to three encodings (URL with %20,
 * URL with "+", JSON, JSON with "/" as "\/") never reaches the logs, KV or the
 * returned payload in any decoded view. The Worker refuses a key with
 * whitespace, so the key carries every other awkward character.
 */
const FUZZ_ENCODINGS = {
    'URL %20': (text) => encodeURIComponent(text),
    'URL +': (text) => new URLSearchParams({ s: text }).toString().slice(2),
    JSON: (text) => JSON.stringify(text).slice(1, -1),
    'JSON \\/': (text) => JSON.stringify(text).slice(1, -1).split('/').join('\\/'),
};

function encodingSequences() {
    let layer = [[[], (text) => text]];
    const all = [];
    for (let depth = 0; depth < 3; depth++) {
        layer = layer.flatMap(([names, encode]) =>
            Object.entries(FUZZ_ENCODINGS).map(([name, step]) => [[...names, name], (text) => step(encode(text))]));
        all.push(...layer);
    }
    return all.map(([names, encode]) => [names.join(' > '), encode]);
}

/** Decoders written independently of the Worker's: whole-string where the platform allows. */
function decodedViews(text) {
    const decoders = [
        (t) => { try { return decodeURIComponent(t); } catch (err) { return unescape(t); } },
        (t) => { const s = t.replace(/\+/g, ' '); try { return decodeURIComponent(s); } catch (err) { return unescape(s); } },
        (t) => {
            try {
                return JSON.parse(`"${t}"`);
            } catch (err) {
                return t.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\(["\\/])/g, '$1');
            }
        },
    ];
    const seen = new Set([text]);
    let layer = [text];
    for (let i = 0; i < 3; i++) {
        layer = layer.flatMap((view) => decoders.map((decode) => decode(view))).filter((view) => !seen.has(view) && seen.add(view));
    }
    return [...seen];
}

/** Keys shuffled by a seeded generator (mulberry32), so a failure reproduces. */
function fuzzKeys() {
    let state = 20261112;
    const random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const keys = [`key"/+%&=<>'\\z`];
    for (let i = 0; i < 2; i++) {
        const chars = [...`"/\\+%&=<>'`, ...'Ab3xQ9'];
        for (let j = chars.length - 1; j > 0; j--) {
            const k = Math.floor(random() * (j + 1));
            [chars[j], chars[k]] = [chars[k], chars[j]];
        }
        keys.push(`k${chars.join('')}z`);
    }
    return keys;
}

const FUZZ_SHAPES = {
    '200 JSON error': (echo) => jsonResponse(200, { error: `Invalid API key ${echo}` }),
    '200 success false': (echo) => jsonResponse(200, { success: false, message: `Rejected ${echo}` }),
    '400 text': (echo) => new Response(`Bad Request: [${echo}]`, { status: 400, headers: { 'content-type': 'text/plain' } }),
    '500 JSON error': (echo) => jsonResponse(500, { error: `failed for ${echo}` }),
    '200 result quoting the key': (echo) => jsonResponse(200, { status: 'valid', note: `seen ${echo}` }),
    'transport error': (echo) => { throw new TypeError(`fetch failed: ${echo}`); },
};

test('the API key never reaches the logs, KV or the payload in any decoded view, through any sequence of up to three encodings', async () => {
    const sequences = encodingSequences();
    assert.strictEqual(sequences.length, 4 + 16 + 64);
    const leaks = [];
    for (const key of fuzzKeys()) {
        for (const [sequence, encode] of sequences) {
            assert.ok(decodedViews(encode(key)).includes(key), `the test cannot decode ${sequence}`);
            for (const [shape, respond] of Object.entries(FUZZ_SHAPES)) {
                const kv = recordingKv();
                const { context, errors, logs } = loadWorker({ API_KEY: key, VALID_STATUS: ['valid'], LOGS: kv.LOGS });
                context.fetch = async (input) => (input instanceof Request ? new Response('origin response') : respond(encode(key)));
                await context.handleRequest(fetchEvent(formRequest('email=test%40example.com')));
                assert.strictEqual(kv.puts.length, 1, `${shape} / ${sequence}: nothing stored`);
                const texts = [...kv.puts.map((p) => p.key + p.value), ...errors, ...logs];
                if (texts.some((text) => decodedViews(text).some((view) => view.includes(key)))) {
                    leaks.push(`${shape} / ${sequence}`);
                }
            }
        }
    }
    assert.deepStrictEqual(leaks, []);
});

test('the API key is also caught through \\uXXXX escapes and URL encoding that keeps "+"', async () => {
    // PHP's json_encode (JSON_HEX_*) and Python's ensure_ascii write <
    // and friends; escape() and some URL encoders leave "+" as it is, so "+"
    // must not be read as a space there.
    const unicodeEscaped = (text) => [...text].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const plusKept = (text) => encodeURIComponent(text).split('%2B').join('+');
    const sequences = {
        '\\u escapes': unicodeEscaped,
        '\\u escapes > URL %20': (text) => encodeURIComponent(unicodeEscaped(text)),
        'URL keeping + > URL keeping +': (text) => plusKept(plusKept(text)),
        'escape() > escape()': (text) => escape(escape(text)),
    };
    const leaks = [];
    for (const key of fuzzKeys()) {
        for (const [sequence, encode] of Object.entries(sequences)) {
            assert.ok(decodedViews(encode(key)).includes(key), `the test cannot decode ${sequence}`);
            const { context, errors } = loadWorker({ API_KEY: key });
            context.fetch = async () => jsonResponse(200, { error: `Invalid API key [${encode(key)}]` });
            const result = await context.validateEmail('test@example.com', '198.51.100.7');
            if ([result, ...errors].some((text) => decodedViews(text).some((view) => view.includes(key)))) {
                leaks.push(sequence);
            }
        }
    }
    assert.deepStrictEqual(leaks, []);
});

// ---------------------------------------------------------------------------
// Round-13 guards: JSON depth limit, wrong shape, and each decode step
// ---------------------------------------------------------------------------

test('a body nested deeper than the JSON depth limit is a failure with HTTP 200, and the submission is forwarded', async () => {
    const deep = 200000;
    const nested = (depth) => `{"address":"a@example.com","status":"valid","a":${'['.repeat(depth - 1)}${']'.repeat(depth - 1)}}`;
    const tooDeep = { error: 'HTTP 200', message: 'ZeroBounce returned a response nested too deeply to read' };
    for (const body of ['['.repeat(deep) + ']'.repeat(deep), '['.repeat(deep), nested(deep), nested(513)]) {
        const kv = recordingKv();
        const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'], LOGS: kv.LOGS });
        context.fetch = async (input) => (input instanceof Request
            ? (calls.forwarded.push(input), new Response('origin response'))
            : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
        const result = await context.validateEmail('test@example.com', '198.51.100.7');
        assert.deepStrictEqual(JSON.parse(result), tooDeep);
        await context.handleRequest(fetchEvent(formRequest('email=test%40example.com')));
        assert.strictEqual(await calls.forwarded[0].text(), 'email=test%40example.com');
        assert.strictEqual(kv.puts.length, 1);
    }
    // At the limit, and with brackets only inside a string, it is still a result.
    for (const body of [nested(512), `{"address":"a@example.com","status":"valid","a":"${'['.repeat(deep)}"}`]) {
        const { context } = loadWorker({ API_KEY });
        context.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        const result = await context.validateEmail('test@example.com', '198.51.100.7');
        assert.strictEqual(result.status, 'valid');
    }
});

test('strict JSON of the wrong shape on a 2xx is a failure with HTTP 200, never a result (E7)', async () => {
    // Arrays, positional ones included, are never a result object.
    for (const body of ['0', '"x"', 'true', 'null', '[]', '["x"]', '["test@example.com","valid"]', '[true,"3"]', '[{"status":"valid"}]', '{}', '{"address":"a@example.com"}']) {
        const { context } = loadWorker({ API_KEY });
        context.fetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
        const result = await context.validateEmail('test@example.com', '198.51.100.7');
        assert.strictEqual(typeof result, 'string', body);
        assert.strictEqual(JSON.parse(result).error, 'HTTP 200', body);
    }
});

const NON_ASCII_KEY = 'käy-Sécret-\u{1F600}';
const percentAll = (text, lower = false) => [...Buffer.from(text, 'utf8')]
    .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
    .map((pct) => (lower ? pct : pct.toUpperCase()))
    .join('');
const unicodeAll = (text) => [...text].flatMap((char) => (char.length === 2 ? [char[0], char[1]] : [char]))
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');

function assertHeld(key, echo) {
    const { context } = loadWorker({ API_KEY: key });
    assert.strictEqual(context.holdsKey(`Bad Request: [${echo}]`, key), true, echo);
    assert.strictEqual(context.redactKey(`Bad Request: [${echo}]`).includes('Bad Request'), false, echo);
}

test('the decode check reads %XX in upper- and lower-case hex', () => {
    for (const key of [API_KEY, NON_ASCII_KEY]) {
        assertHeld(key, percentAll(key));
        assertHeld(key, percentAll(key, true));
    }
});

test('the decode check reads a %XX run that is not valid UTF-8 as a whole, one sequence at a time', () => {
    for (const junk of ['%FF', '%ff', '%C3', '%80', '%E4', '%F0%9F', '%ED%A0%80']) {
        for (const key of [API_KEY, NON_ASCII_KEY]) {
            assertHeld(key, `${junk}${percentAll(key)}`);
            assertHeld(key, `${percentAll(key)}${junk}`);
        }
    }
    const { context } = loadWorker({ API_KEY });
    assert.strictEqual(context.redactKey('Bad Request: [%FF%41%C3 %e4]'), 'Bad Request: [%FF%41%C3 %e4]');
});

test('the decode check reads every UTF-8 sequence length (2, 3 and 4 bytes) in a run that is not valid UTF-8 as a whole', () => {
    // Keys made only of 2-, 3- or 4-byte characters (API_KEY allows them): no
    // ASCII between them splits the run, so the one-sequence-at-a-time decoder
    // alone must read each length; dropping one from utf8SequenceLength leaks it.
    for (const key of ['éééééééé', '€€€€€€€€', '\u{1F600}\u{1F600}\u{1F600}\u{1F600}']) {
        for (const junk of ['%FF', '%ff', '%80']) {
            for (const lower of [false, true]) {
                const { context } = loadWorker({ API_KEY: key });
                for (const echo of [`${junk}${percentAll(key, lower)}`, `${percentAll(key, lower)}${junk}`]) {
                    assert.strictEqual(context.holdsKey(`Bad Request: [${echo}]`, key), true, echo);
                    // Lower-case hex is no spelling the redaction replaces, so only the check catches it.
                    if (lower) assertHeld(key, echo);
                }
            }
        }
    }
});

test('the decode check reads brace, hex, octal and wide-U quote spellings, and folds case', () => {
    const key = "a'b";
    assertHeld(key, 'a\\u{27}b');
    assertHeld(key, 'a\\U{27}b');
    assertHeld(key, 'a\\U00000027b');
    assertHeld(key, 'a\\047b');
    assertHeld(key, 'a\\x27b');
    const { context } = loadWorker({ API_KEY: key });
    assert.strictEqual(context.holdsKey('a%u0027b', key), false);
    assertHeld('\u00df', 'SS');
    assertHeld('\u1F80\u0301', '\u1F84');
    assertHeld('\u1F84', '\u1F80\u0301');
});

test('the decode check reads "+" as a space, JSON escapes and \\uXXXX with surrogate pairs', () => {
    assertHeld('k ey-z', percentAll('k ey-z').split('%20').join('+'));
    assertHeld(NON_ASCII_KEY, unicodeAll(NON_ASCII_KEY));
    assertHeld('a"b\\c/d', '\\u0061\\"\\u0062\\\\\\u0063\\/\\u0064');
});

test('a NUL or %00 in the body does not end the decode check', () => {
    assertHeld(API_KEY, `\u0000${percentAll(API_KEY)}`);
    assertHeld(API_KEY, `%00${percentAll(API_KEY)}`);
    assertHeld(API_KEY, `\\u0000${unicodeAll(API_KEY)}`);
});

test('the decode check covers four layers: the request encoding plus three echo layers', () => {
    const key = 'k%e+y/"z';
    let echo = key;
    for (let i = 0; i < 4; i++) echo = encodeURIComponent(echo);
    assertHeld(key, echo);
    const json = (text) => JSON.stringify(text).slice(1, -1);
    assertHeld(key, encodeURIComponent(json(encodeURIComponent(json(key)))));
});

// ---------------------------------------------------------------------------
// Fix round 1: multipart parsing (H1), repeated fields (M1), key check (M2),
// missing key (M3), status (M4), entities (M5), U+0307 (M6) and the Lows
// ---------------------------------------------------------------------------

/** A POST through the handler; the validation answers with `status`. Returns what reached the origin and the stubs. */
async function runHandler(request, { bindings = {}, status = 'invalid', kv = null } = {}) {
    const worker = loadWorker(
        { API_KEY, VALID_STATUS: ['valid'], ...(kv ? { LOGS: kv.LOGS } : {}), ...bindings },
        { validationResponse: { address: 'test@example.com', status } }
    );
    await worker.context.handleRequest(fetchEvent(request));
    const forwarded = worker.calls.forwarded[0];
    const body = new Uint8Array(await forwarded.arrayBuffer());
    return { ...worker, body, text: new TextDecoder().decode(body) };
}

const MP = 'zb-b';
function mpBody(...parts) {
    return parts.map((part) => `--${MP}\r\n${part}\r\n`).join('') + `--${MP}--\r\n`;
}
function mpRequest(body) {
    return multipartRequest(body, `multipart/form-data; boundary=${MP}`);
}
const field = (name, value, extraHeaders = '') => `Content-Disposition: form-data; name="${name}"\r\n${extraHeaders}\r\n${value}`;

test('H1: a text part of 64 KiB of n, r or backslash is scanned in linear time and no address is invented', async () => {
    for (const filler of ['n', 'r', '\\', 'nr\\\\']) {
        const body = mpBody(field('message', filler.repeat(65536 / filler.length)), field('tail', 'anna@x.com junk'));
        const started = Date.now();
        const { calls, text } = await runHandler(mpRequest(body));
        const elapsed = Date.now() - started;

        assert.ok(elapsed < 2000, `took ${elapsed} ms for ${JSON.stringify(filler)}`);
        assert.strictEqual(calls.validation.length, 0);
        assert.strictEqual(text, body);
    }
});

test('H1: an address after extra part headers is read whole, not from its second letter', async () => {
    const body = mpBody(field('contact', 'anna@x.com', 'Content-Type: text/plain\r\nX-Note: n\r\n'));
    const { calls, text } = await runHandler(mpRequest(body));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'anna@x.com');
    assert.strictEqual(text, mpBody(field('contact', 'INVALID', 'Content-Type: text/plain\r\nX-Note: n\r\n')));
});

test('H1: a part with its own Content-Type text/plain is still a text field', async () => {
    const body = mpBody(field('email', 'a.b@x.com', 'Content-Type: text/plain; charset=utf-8\r\n'));
    const { calls } = await runHandler(mpRequest(body), { status: 'valid' });

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'a.b@x.com');
});

test('H1: the field name may be quoted or a token, in any case of the parameter, with bare LF line breaks', async () => {
    for (const disposition of ['form-data; name=email', 'form-data; NAME="email"', 'FORM-DATA;name = "email"', 'form-data; name="email"; x=1']) {
        const body = `--${MP}\ncontent-disposition: ${disposition}\n\nperson@x.com\n--${MP}--\n`;
        const { calls, text } = await runHandler(mpRequest(body));

        assert.strictEqual(calls.validation.length, 1, disposition);
        assert.strictEqual(text, `--${MP}\ncontent-disposition: ${disposition}\n\nINVALID\n--${MP}--\n`, disposition);
    }
});

test('H1: a part named email wins over an earlier text part that holds an address', async () => {
    const body = mpBody(field('contact', 'first@x.com'), field('email', 'second@x.com'));
    const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'second@x.com');
    assert.strictEqual(text, body);
});

test('H1: without a named part, the first text part whose whole value is an address is used; an address inside prose is not', async () => {
    const body = mpBody(field('note', 'write to me at prose@x.com please'), field('who', 'whole@x.com'));
    const { calls } = await runHandler(mpRequest(body), { status: 'valid' });

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'whole@x.com');
});

test('H1: a value longer than 320 characters is never an address', async () => {
    const body = mpBody(field('who', `${'a'.repeat(400)}@x.com`));
    const { calls } = await runHandler(mpRequest(body));

    assert.strictEqual(calls.validation.length, 0);
});

test('H1: only the value bytes are replaced; the whitespace around them stays', async () => {
    const body = mpBody(field('email', '  \tperson@x.com \n '));
    const { calls, text } = await runHandler(mpRequest(body));

    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'person@x.com');
    assert.strictEqual(text, mpBody(field('email', '  \tINVALID \n ')));
});

test('H1: a plain filename with a value marks a file; filename* does not (PHP reads it as a text field)', async () => {
    const file = 'Content-Disposition: form-data; name="doc"; filename="x.txt"\r\n\r\nsomeone@x.com';
    const star = 'Content-Disposition: form-data; name="doc2"; filename*=UTF-8\'\'a.txt\r\n\r\nother@x.com';
    assert.strictEqual((await runHandler(mpRequest(mpBody(file)))).calls.validation.length, 0);
    const { calls } = await runHandler(mpRequest(mpBody(file, star)));
    assert.deepStrictEqual(validated(calls), ['other@x.com']);

    // A filename that quotes name="email" is still a file: PHP and undici
    // keep it out of the form fields, so it is never read and never rewritten.
    const text = mpBody('Content-Disposition: form-data; name="x"; filename="a; name=email"\r\n\r\nsomeone@x.com');
    const read = await runHandler(mpRequest(text));
    assert.strictEqual(read.calls.validation.length, 0);
    assert.strictEqual(read.text, text);
});

test('H1: a text part whose name hides in a quoted parameter value is read by its real name', async () => {
    const body = mpBody('Content-Disposition: form-data; x="; name=email"; name="note"\r\n\r\nperson@x.com');
    const { calls } = await runHandler(mpRequest(body), { status: 'valid' });

    assert.strictEqual(calls.validation.length, 1);
});

// --- M1 ---------------------------------------------------------------------

test('M1: repeated and alias fields cost one validation; every other candidate value that differs becomes INVALID, whatever the status', async () => {
    const cases = [
        ['email=a%40x.com&email=b%40x.com', 'email=a%40x.com&email=INVALID'],
        ['email=a%40x.com&your-email=b%40x.com', 'email=a%40x.com&your-email=INVALID'],
        // The first email field named exactly email, your-email or your_email wins, by position.
        ['your-email=b%40x.com&email=a%40x.com&email=a%40x.com', 'your-email=b%40x.com&email=INVALID&email=INVALID'],
        // A value that is not an address is left alone.
        ['email=junk&email=a%40x.com', 'email=junk&email=a%40x.com'],
        ['email=a%40x.com&email=&n=1', 'email=a%40x.com&email=&n=1'],
        ['contact=a%40x.com&contact=b%40x.com', 'contact=a%40x.com&contact=INVALID'],
        ['contact=a%40x.com&contact=b%40x.com&email2=c%40x.com', 'contact=a%40x.com&contact=b%40x.com&email2=c%40x.com'],
    ];
    for (const [sent, expected] of cases) {
        const { calls, text } = await runHandler(formRequest(sent), { status: 'valid' });
        assert.strictEqual(calls.validation.length, 1, sent);
        assert.strictEqual(text, expected, sent);
    }
});

test('M1: a rejected address rewrites every candidate value, repeats and aliases included', async () => {
    const { calls, text } = await runHandler(formRequest('email=a%40x.com&n=1&your-email=b%40x.com&email=c%40x.com'));

    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(text, 'email=INVALID&n=1&your-email=INVALID&email=INVALID');
});

test('M1: a fail-open validation leaves repeated fields untouched, and so does an unset VALID_STATUS', async () => {
    const sent = 'email=a%40x.com&email=b%40x.com';
    const failing = loadWorker({ API_KEY: 'bad key', VALID_STATUS: ['valid'] });
    await failing.context.handleRequest(fetchEvent(formRequest(sent)));
    assert.strictEqual(await failing.calls.forwarded[0].text(), sent);

    const open = await runHandler(formRequest(sent), { bindings: { VALID_STATUS: undefined } });
    assert.strictEqual(open.text, sent);
});

test('M1: a leading ? is part of the field name; ?email is not email', async () => {
    const { calls, text } = await runHandler(formRequest('%3Femail=zz%40x.com&?email=a%40x.com&email=b%40x.com'), { status: 'valid' });

    // The exact name wins; the other fields contain "email" and hold other addresses.
    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'b@x.com');
    assert.strictEqual(text, '%3Femail=INVALID&?email=INVALID&email=b%40x.com');

    const only = await runHandler(formRequest('?email=a%40x.com'), { status: 'valid' });
    // Found as the first email field holding an address (its name is not exactly "email").
    assert.strictEqual(only.calls.validation.length, 1);
    assert.ok(only.logs.some((line) => line.startsWith('Found email input')));
});

test('M1: repeated multipart fields follow the same rule', async () => {
    const body = mpBody(field('email', 'a@x.com'), field('your-email', 'b@x.com'), field('email', 'c@x.com'));
    const valid = await runHandler(mpRequest(body), { status: 'valid' });
    assert.strictEqual(valid.calls.validation.length, 1);
    assert.strictEqual(valid.text, mpBody(field('email', 'a@x.com'), field('your-email', 'INVALID'), field('email', 'INVALID')));

    const rejected = await runHandler(mpRequest(body));
    assert.strictEqual(rejected.text, mpBody(field('email', 'INVALID'), field('your-email', 'INVALID'), field('email', 'INVALID')));
});

test('M1: JSON email and your-email keys follow the same rule', async () => {
    const make = (form) => new Request('https://example.com/f', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ form: JSON.stringify(form), other: 1 }),
    });
    const valid = await runHandler(make({ email: 'a@x.com', 'your-email': 'b@x.com' }), { status: 'valid' });
    assert.strictEqual(valid.calls.validation.length, 1);
    assert.deepStrictEqual(JSON.parse(JSON.parse(valid.text).form), { email: 'a@x.com', 'your-email': 'INVALID' });

    const rejected = await runHandler(make({ email: 'a@x.com', 'your-email': 'b@x.com' }));
    assert.deepStrictEqual(JSON.parse(JSON.parse(rejected.text).form), { email: 'INVALID', 'your-email': 'INVALID' });
});

// --- M2 ---------------------------------------------------------------------

const AUDITOR_KEY_CHARS = [
    0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
    0x2067, 0x2068, 0x2069, 0x061c, 0x0601, 0x0602, 0x0603, 0x0604, 0x0605, 0xfffa, 0xfffb,
    0x1d174, 0x1d17a, 0xe0001, 0xe0020, 0xe007f, 0x034f, 0x115f, 0x3164, 0xffa0, 0x17b4,
    // The lesson 135 list and the usual whitespace.
    0x00ad, 0x0600, 0x0890, 0x0891, 0x180b, 0x180f, 0x200b, 0x202e, 0x2066, 0xfff9, 0x1d173, 0xfeff, 0x00a0, 0x2028, 0x2029, 0x3000, 0x0085,
    0xe000, 0xf8ff, 0xd800, 0xdfff, 0x0378, 0x00e9, 0x4e2d,
];

test('M2: a key with any character outside printable ASCII is refused, and no request is made', async () => {
    for (const code of AUDITOR_KEY_CHARS) {
        const char = String.fromCodePoint(code);
        for (const key of [`${API_KEY}${char}`, `${char}${API_KEY}`, `zb-dummy${char}key`]) {
            const { context, calls, errors } = loadWorker({ API_KEY: key, VALID_STATUS: ['valid'] });
            await context.handleRequest(fetchEvent(formRequest('email=test%40example.com')));
            assert.strictEqual(calls.validation.length, 0, `U+${code.toString(16)} in ${JSON.stringify(key)}`);
            assert.ok(errors.some((line) => line.includes('API_KEY')));
        }
    }
});

test('M2: printable ASCII keys, every symbol included, are accepted', async () => {
    const all = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i)).join('');
    for (const key of [API_KEY, all, '!', '~']) {
        const { context, calls } = loadWorker({ API_KEY: key });
        await context.validateEmail('test@example.com', null);
        assert.strictEqual(calls.validation.length, 1, key);
    }
});

// --- M3 ---------------------------------------------------------------------

test('M3: a handler request without an API_KEY fails open with a log and a KV failure record, and does not throw', async () => {
    for (const unset of [{ unbind: ['API_KEY'] }, { bindings: { API_KEY: null } }]) {
        const kv = recordingKv();
        const worker = loadWorker({ VALID_STATUS: ['valid'], LOGS: kv.LOGS, ...(unset.bindings || {}) }, { unbind: unset.unbind || [] });
        const sent = 'email=test%40example.com&name=Test';

        await worker.context.handleRequest(fetchEvent(formRequest(sent)));

        assert.strictEqual(worker.calls.validation.length, 0);
        assert.strictEqual(await worker.calls.forwarded[0].text(), sent);
        assert.ok(worker.errors.some((line) => line.includes('API_KEY is not set')), JSON.stringify(worker.errors));
        assert.strictEqual(kv.puts.length, 1);
        assert.strictEqual(JSON.parse(kv.puts[0].value).error, 'Missing API_KEY');
    }
});

test('M3: a missing API_KEY fails open on multipart and JSON bodies too', async () => {
    const json = new Request('https://example.com/f', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ form: JSON.stringify({ email: 'a@x.com' }) }),
    });
    for (const request of [mpRequest(mpBody(field('email', 'a@x.com'))), json]) {
        const worker = loadWorker({ VALID_STATUS: ['valid'] }, { unbind: ['API_KEY'] });
        const sent = await request.clone().text();
        await worker.context.handleRequest(fetchEvent(request));
        assert.strictEqual(await worker.calls.forwarded[0].text(), sent);
        assert.ok(worker.errors.some((line) => line.includes('API_KEY is not set')));
    }
});

// --- M4 ---------------------------------------------------------------------

test('M4: a 2xx status that is not a documented status is a failure; the text is not logged', async () => {
    for (const status of ['x', 'a_status_added_later', '', `echo ${API_KEY}`, 'validx']) {
        const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status } });
        const sent = 'email=test%40example.com';
        await worker.context.handleRequest(fetchEvent(formRequest(sent)));

        assert.strictEqual(await worker.calls.forwarded[0].text(), sent, JSON.stringify(status));
        assert.ok(worker.errors.some((line) => line.startsWith('ZeroBounce validation failed')), JSON.stringify(status));
        for (const line of [...worker.logs, ...worker.errors]) {
            assert.ok(!line.includes(API_KEY), line);
            assert.ok(!line.includes('a_status_added_later'), line);
        }
    }
});

test('M4: every documented status is accepted, trimmed and in any case', async () => {
    for (const status of ['valid', 'invalid', 'catch-all', 'unknown', 'spamtrap', 'abuse', 'do_not_mail', ' Valid ', 'CATCH-ALL']) {
        const { context } = loadWorker({ API_KEY }, { validationResponse: { address: 'test@example.com', status } });
        const result = await context.validateEmail('test@example.com', null);
        assert.strictEqual(result.status, status.trim().toLowerCase(), status);
    }
});

test('M4: the status is judged against VALID_STATUS after normalising its case', async () => {
    const { calls, text } = await runHandler(formRequest('email=a%40x.com'), { status: ' VALID ' });
    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(text, 'email=a%40x.com');
});

// --- M5 ---------------------------------------------------------------------

test('M5: the key spelled with HTML entities is masked, in numeric and named spellings, over up to four layers', () => {
    const KEY = 'zb-dummy-key-ab_c';
    const { context } = loadWorker({ API_KEY: KEY });
    const spellings = [
        'zb-dummy-key-&#97;b_c', 'zb-dummy-key-&#x61;b_c', 'zb-dummy-key-&#X61;b_c', 'zb-dummy-key-&#0000097;b_c',
        'zb-dummy-key-&#97b_c', 'zb-dummy-key-&#x0061b_c'.replace('b_c', ';b_c'), 'zb-dummy-key-a&#98;_c', 'zb-dummy-key-ab&lowbar;c',
        'zb-dummy-key-ab&LOWBAR;c', 'zb-dummy-key-ab&#95c', '&#122;&#98;-dummy-key-ab_c', 'zb&hyphen;dummy&dash;key-ab_c'.replace('&dash;', '-'),
        'zb-dummy-key-&amp;#97;b_c', 'zb-dummy-key-&amp;amp;#97;b_c', 'zb-dummy-key-%26%2397%3Bb_c', 'zb-dummy-key-&#37;61b_c',
    ];
    for (const spelling of spellings) {
        assert.strictEqual(context.redactKey(`echo ${spelling} end`), 'the response text was omitted because it contained a credential', spelling);
    }
});

test('M5: an entity-looking text that does not spell the key is left alone', () => {
    const { context } = loadWorker({ API_KEY });
    const text = 'fish &amp; chips &#9999999999; &unknown; &#; & &lt;b&gt;';
    assert.strictEqual(context.redactKey(text), text);
});

test('M5: entity decoding of a 1 MiB body of ampersands finishes in linear time', () => {
    const { context } = loadWorker({ API_KEY });
    for (const unit of ['&', '&#', '&amp;', '&#x']) {
        const body = unit.repeat(Math.ceil((1 << 20) / unit.length));
        const started = Date.now();
        context.redactKey(body);
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 20000, `${JSON.stringify(unit)} took ${elapsed} ms`);
    }
});

// --- M6 ---------------------------------------------------------------------

test('M6: U+0130 in the key, echoed as a plain I, is masked (the dot above is dropped after i)', () => {
    const { context } = loadWorker({ API_KEY: 'zb-dummy-key-\u0130x' });

    assert.strictEqual(context.redactKey('echo zb-dummy-key-Ix end'), 'the response text was omitted because it contained a credential');
    assert.strictEqual(context.redactKey('echo zb-dummy-key-ix end'), 'the response text was omitted because it contained a credential');
    assert.strictEqual(context.redactKey('echo zb-dummy-key-jx end'), 'echo zb-dummy-key-jx end');
});

// --- Lows --------------------------------------------------------------------

test('Low: an error whose name quotes the key is redacted in the log and in the payload', async () => {
    const { context, errors } = loadWorker({ API_KEY });
    context.fetch = async () => {
        const error = new Error('down');
        error.name = `Failed ${API_KEY}`;
        throw error;
    };
    const result = await context.validateEmail('test@example.com', null);

    assert.ok(!result.includes(API_KEY));
    for (const line of errors) assert.ok(!line.includes(API_KEY), line);
});

test('Low: every JSON key that contains email is an email field; its value is read only when it is an address', async () => {
    const make = (form) => new Request('https://example.com/f', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ form: JSON.stringify(form) }),
    });
    for (const form of [{ email_password: 'hunter2secret' }, { note: 'a@x.com' }]) {
        const worker = await runHandler(make(form));
        assert.strictEqual(worker.calls.validation.length, 0, JSON.stringify(form));
        for (const line of worker.logs) assert.ok(!line.includes('hunter2secret'), line);
    }
    for (const key of ['emailConfirm', 'Email', 'EMAIL_2']) {
        const worker = await runHandler(make({ [key]: 'a@x.com' }));
        assert.deepStrictEqual(validated(worker.calls), ['a@x.com'], key);
        assert.deepStrictEqual(JSON.parse(JSON.parse(worker.text).form), { [key]: 'INVALID' }, key);
    }
    const ok = await runHandler(make({ email_password: 'x', 'your-email': 'a@x.com' }));
    assert.strictEqual(ok.calls.validation.length, 1);
    assert.deepStrictEqual(JSON.parse(JSON.parse(ok.text).form), { email_password: 'x', 'your-email': 'INVALID' });
});

test('Low: a JSON body that does not parse, or whose form is not JSON, is forwarded untouched', async () => {
    for (const body of ['{oops', JSON.stringify({ form: '{oops' }), JSON.stringify({ form: 5 }), 'null', JSON.stringify({ form: '[1]' })]) {
        const request = new Request('https://example.com/f', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        const worker = await runHandler(request);
        assert.strictEqual(worker.calls.validation.length, 0, body);
        assert.strictEqual(worker.text, body);
    }
});

test('Low: a url-encoded email field that is not an address is neither sent nor logged', async () => {
    const worker = await runHandler(formRequest('email=hunter2secret&name=x'));

    assert.strictEqual(worker.calls.validation.length, 0);
    assert.strictEqual(worker.text, 'email=hunter2secret&name=x');
    for (const line of worker.logs) assert.ok(!line.includes('hunter2secret'), line);

    // ... and the search falls back as if the field were absent.
    const fallback = await runHandler(formRequest('email=hunter2secret&contact=a%40x.com'), { status: 'valid' });
    assert.strictEqual(fallback.calls.validation[0].url.searchParams.get('email'), 'a@x.com');
});

test('Low: VALID_STATUS and BYPASS_PATH bound as text: a JSON array, or one plain entry', async () => {
    const sent = 'email=a%40x.com';
    for (const [VALID_STATUS, status, rewritten] of [
        ['["valid","catch-all"]', 'catch-all', false],
        ['valid', 'valid', false],
        ['valid', 'invalid', true],
        ['  ["valid"]  ', 'invalid', true],
        ['[valid', 'valid', false], // not JSON: the bracket is dropped, the entry is "valid"
    ]) {
        const { text } = await runHandler(formRequest(sent), { bindings: { VALID_STATUS }, status });
        assert.strictEqual(text, rewritten ? 'email=INVALID' : sent, `${VALID_STATUS} ${status}`);
    }

    for (const [BYPASS_PATH, bypassed] of [
        ['/subscribe', true],
        ['["/other", "/subscribe"]', true],
        ['/', false],
        ['/sub', false],
        ['/subscribe/', false],
        [['/subscribe'], true],
        ['', false],
    ]) {
        const { calls } = await runHandler(formRequest(sent), { bindings: { BYPASS_PATH } });
        assert.strictEqual(calls.validation.length, bypassed ? 0 : 1, JSON.stringify(BYPASS_PATH));
    }
});

test('Low: a malformed VALID_STATUS or BYPASS_PATH is logged once per request and then ignored', async () => {
    for (const bad of [42, { a: 1 }, [1, 2], true]) {
        const worker = loadWorker({ API_KEY, VALID_STATUS: bad, BYPASS_PATH: bad });
        await worker.context.handleRequest(fetchEvent(formRequest('email=a%40x.com&x=1')));
        const lines = (name) => worker.logs.filter((line) => line.startsWith(`Ignoring ${name}`));
        assert.strictEqual(lines('VALID_STATUS').length, 1, JSON.stringify(bad));
        assert.strictEqual(lines('BYPASS_PATH').length, 1, JSON.stringify(bad));
        assert.strictEqual(await worker.calls.forwarded[0].text(), 'email=a%40x.com&x=1');
    }
});

test('Low: API_TIMEOUT accepts whole milliseconds from 1 to 600000 and logs and replaces everything else', async () => {
    const accepted = [[1, 1], [5000, 5000], ['5000', 5000], [' 250 ', 250], [600000, 600000], ['600000', 600000]];
    for (const [value, expected] of accepted) {
        const seen = [];
        const { context, logs } = loadWorker({ API_KEY, API_TIMEOUT: value, AbortSignal: recordingAbortSignal(seen) });
        await context.validateEmail('test@example.com', null);
        assert.deepStrictEqual(seen, [expected], String(value));
        assert.ok(!logs.some((line) => line.includes('Invalid API_TIMEOUT')), String(value));
    }

    for (const value of ['', ' ', 0, '0', -1, 1.5, '1.5', 600001, 1e12, '1e3', '0x10', Infinity, NaN, 'soon', true, {}, []]) {
        const seen = [];
        const { context, logs } = loadWorker({ API_KEY, API_TIMEOUT: value, AbortSignal: recordingAbortSignal(seen) });
        await context.validateEmail('test@example.com', null);
        assert.deepStrictEqual(seen, [10000], `API_TIMEOUT=${JSON.stringify(value)}`);
        assert.ok(logs.some((line) => line.includes('Invalid API_TIMEOUT')), `API_TIMEOUT=${String(value)}`);
    }

    // Not set, or null: the default, silently.
    for (const bindings of [{ API_TIMEOUT: null }, {}]) {
        const seen = [];
        const { context, logs } = loadWorker({ API_KEY, AbortSignal: recordingAbortSignal(seen), ...bindings }, { unbind: bindings.API_TIMEOUT === undefined ? ['API_TIMEOUT'] : [] });
        await context.validateEmail('test@example.com', null);
        assert.deepStrictEqual(seen, [10000]);
        assert.ok(!logs.some((line) => line.includes('Invalid API_TIMEOUT')));
    }
});

test('Low: the KV key stays within 512 bytes of UTF-8, keeps its date prefix and never splits a code point', async () => {
    const long = `${'a'.repeat(300)}@x.com`;
    const cases = [
        [long, `/${'p'.repeat(2000)}`],
        ['a@x.com', `/${'\u{1F600}'.repeat(600)}`],
        [`${'\u00e9'.repeat(200)}@x.com`.slice(0, 250), `/${'\u4e2d'.repeat(400)}`],
        ['a@x.com', '/short'],
    ];
    for (const [email, path] of cases) {
        const kv = recordingKv();
        const worker = loadWorker({ API_KEY, LOGS: kv.LOGS });
        worker.context.logValidation({ waitUntil: () => {} }, email, path, { status: 'valid' });
        await Promise.resolve();
        // Called through waitUntil in the handler; here call it with a spy that runs the promise.
        const events = [];
        worker.context.logValidation({ waitUntil: (p) => events.push(p) }, email, path, { status: 'valid' });
        await Promise.all(events);

        assert.strictEqual(kv.puts.length, 2);
        for (const { key } of kv.puts) {
            const bytes = new TextEncoder().encode(key);
            assert.ok(bytes.length <= 512, `${bytes.length} bytes`);
            assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            assert.match(key, /^\{\d{4}-\d{2}-\d{2}\}-\{/);
            assert.match(key, /\}-\{\d\d:\d\d\}-\d\d\.\d{3}$/);
        }
    }
    // A key that fits is unchanged.
    const kv = recordingKv();
    const worker = loadWorker({ API_KEY, LOGS: kv.LOGS });
    const events = [];
    worker.context.logValidation({ waitUntil: (p) => events.push(p) }, 'a@x.com', '/short', { status: 'valid' });
    await Promise.all(events);
    assert.match(kv.puts[0].key, /^\{\d{4}-\d{2}-\d{2}\}-\{a@x\.com\}-\{\/short\}-\{\d\d:\d\d\}-\d\d\.\d{3}$/);
});

test('Low: the KV value is one JSON object, for a result and for a failure alike', async () => {
    const kv = recordingKv();
    const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'], LOGS: kv.LOGS });
    await worker.context.handleRequest(fetchEvent(formRequest('email=a%40x.com')));
    assert.deepStrictEqual(JSON.parse(kv.puts[0].value), { address: 'test@example.com', status: 'valid' });

    const failing = recordingKv();
    const bad = loadWorker({ API_KEY: 'two words', VALID_STATUS: ['valid'], LOGS: failing.LOGS });
    await bad.context.handleRequest(fetchEvent(formRequest('email=a%40x.com')));
    const stored = JSON.parse(failing.puts[0].value);
    assert.deepStrictEqual(Object.keys(stored), ['error', 'message']);
    assert.strictEqual(stored.error, 'Invalid API_KEY');
});

// --- Transport survivors ------------------------------------------------------

test('transport: the handler hands the KV write to event.waitUntil', async () => {
    const kv = recordingKv();
    const worker = loadWorker({ API_KEY, LOGS: kv.LOGS });
    const waited = [];
    const event = { request: formRequest('email=a%40x.com'), waitUntil: (p) => waited.push(p), passThroughOnException: () => {} };

    await worker.context.handleRequest(event);
    await Promise.all(waited);

    assert.strictEqual(waited.length, 1);
    assert.strictEqual(kv.puts.length, 1);
});

test('transport: an HTML answer is refused whatever the case of its content type', async () => {
    for (const type of ['TEXT/HTML', 'Text/Html; charset=UTF-8']) {
        const { context } = loadWorker({ API_KEY });
        context.fetch = async () => new Response(JSON.stringify({ status: 'valid', address: 'a@x.com' }), { status: 200, headers: { 'content-type': type } });
        const result = await context.validateEmail('a@x.com', null);
        assert.strictEqual(typeof result, 'string', type);
        assert.ok(JSON.parse(result).message.includes('HTML'));
    }
});

test('transport: only POST is validated; PUT, PATCH, DELETE and HEAD forms are forwarded as they are', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
        const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'a@x.com', status: 'invalid' } });
        const request = new Request('https://example.com/subscribe', {
            method,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'email=a%40x.com',
        });
        await worker.context.handleRequest(fetchEvent(request));
        assert.strictEqual(worker.calls.validation.length, 0, method);
        assert.strictEqual(await worker.calls.forwarded[0].text(), 'email=a%40x.com', method);
    }
});

/** A fake answer for statuses Response will not construct (below 200). */
function fakeResponse(status, body = '{}', type = 'application/json') {
    return {
        status,
        headers: new Headers({ 'content-type': type }),
        text: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
}

test('transport: every 3xx answer fails open without being followed or read', async () => {
    for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
        const { context, errors } = loadWorker({ API_KEY });
        context.fetch = async () => fakeResponse(status, JSON.stringify({ status: 'valid', address: 'a@x.com' }));
        const result = JSON.parse(await context.validateEmail('a@x.com', null));
        assert.strictEqual(result.error, 'Redirect', String(status));
        assert.ok(errors.some((line) => line.includes(`HTTP ${status}`)), String(status));
    }
});

test('transport: answers outside 2xx, 199 and 400 included, are failures even with a result-shaped body', async () => {
    for (const status of [100, 199, 400, 404, 599]) {
        const { context } = loadWorker({ API_KEY });
        context.fetch = async () => fakeResponse(status, JSON.stringify({ status: 'valid', address: 'a@x.com' }));
        const result = await context.validateEmail('a@x.com', null);
        assert.strictEqual(typeof result, 'string', String(status));
        assert.strictEqual(JSON.parse(result).error, `HTTP ${status}`);
    }
    for (const status of [200, 204, 299]) {
        const { context } = loadWorker({ API_KEY });
        context.fetch = async () => fakeResponse(status, JSON.stringify({ status: 'valid', address: 'a@x.com' }));
        assert.strictEqual((await context.validateEmail('a@x.com', null)).status, 'valid', String(status));
    }
});

test('transport: a null API_REGION uses the global host without logging', async () => {
    const { context, calls, logs } = loadWorker({ API_KEY, API_REGION: null });
    await context.validateEmail('a@x.com', null);
    assert.strictEqual(calls.validation[0].url.origin, 'https://api.zerobounce.net');
    assert.ok(!logs.some((line) => line.includes('API_REGION')));
});

// ---------------------------------------------------------------------------
// Round 2: legacy binding formats, parser-difference bypasses, Lows, survivors
// ---------------------------------------------------------------------------

const validated = (calls) => calls.validation.map((call) => call.url.searchParams.get('email'));
const rawMp = (boundary, ...parts) => parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('') + `--${boundary}--\r\n`;
const disp = (name, value, extra = '') => `Content-Disposition: form-data; ${name}\r\n${extra}\r\n${value}`;

test('R2 HIGH: the zerobounce.net guide strings are read as lists', async () => {
    const sent = 'email=a%40x.com';
    for (const [status, rewritten] of [['valid', false], ['catch-all', false], ['unknown', false], ['invalid', true], ['spamtrap', true]]) {
        const { text } = await runHandler(formRequest(sent), { bindings: { VALID_STATUS: "['valid', 'catch-all', 'unknown']" }, status });
        assert.strictEqual(text, rewritten ? 'email=INVALID' : sent, status);
    }
    for (const [path, bypassed] of [['/login', true], ['/logout', true], ['/login,', false], ['/log', false], ['/other', false]]) {
        const { calls } = await runHandler(
            formRequest(sent, { url: `https://example.com${path}` }),
            { bindings: { BYPASS_PATH: "'/login,' '/logout,'" } }
        );
        assert.strictEqual(calls.validation.length, bypassed ? 0 : 1, path);
    }
});

test('R2 HIGH: binding formats - comma list, trailing comma, case, quotes, typed array', async () => {
    const sent = 'email=a%40x.com';
    const cases = [
        ['valid,catch-all', 'catch-all', false],
        ['valid, catch-all', 'catch-all', false],
        ['valid catch-all', 'catch-all', false],
        ['valid,catch-all', 'unknown', true],
        ['["valid",]', 'valid', false],
        ['["valid",]', 'invalid', true],
        ['["Valid"]', 'valid', false],
        ['  ["VALID" , "Catch-All"]  ', 'catch-all', false],
        ['"valid"', 'valid', false],
        ["'Valid'", 'valid', false],
        ['VALID', 'valid', false],
        ['valid,', 'valid', false],
        [['Valid ', '', 'catch-all,'], 'catch-all', false],
        [['Valid'], 'invalid', true],
    ];
    for (const [VALID_STATUS, status, rewritten] of cases) {
        const { text } = await runHandler(formRequest(sent), { bindings: { VALID_STATUS }, status });
        assert.strictEqual(text, rewritten ? 'email=INVALID' : sent, `${JSON.stringify(VALID_STATUS)} ${status}`);
    }
    // Paths match exactly, with their case.
    for (const [BYPASS_PATH, path, bypassed] of [['/Login', '/login', false], ['/Login', '/Login', true], [['/a', '/b,'], '/b', true], ['/a,/b', '/b', true], ['/a /b', '/a', true]]) {
        const { calls } = await runHandler(formRequest(sent, { url: `https://example.com${path}` }), { bindings: { BYPASS_PATH } });
        assert.strictEqual(calls.validation.length, bypassed ? 0 : 1, `${JSON.stringify(BYPASS_PATH)} ${path}`);
    }
});

test('R2 HIGH: a blank or whitespace-only binding is not set, and is logged', async () => {
    const sent = 'email=a%40x.com';
    for (const blank of ['', '   ', '\n\t', ',', "''", '[]', [], ['', ' ']]) {
        const worker = await runHandler(formRequest(sent), { bindings: { VALID_STATUS: blank, BYPASS_PATH: blank }, status: 'invalid' });
        // Nothing is rewritten without a VALID_STATUS list; nothing is bypassed.
        assert.strictEqual(worker.text, sent, JSON.stringify(blank));
        assert.strictEqual(worker.calls.validation.length, 1, JSON.stringify(blank));
        assert.strictEqual(worker.logs.filter((line) => line.startsWith('Ignoring VALID_STATUS')).length, 1, JSON.stringify(blank));
        assert.strictEqual(worker.logs.filter((line) => line.startsWith('Ignoring BYPASS_PATH')).length, 1, JSON.stringify(blank));
    }
});

test('R2: a typed array with a non-string item, or another type, is logged and ignored', async () => {
    for (const bad of [['valid', 1], 7, { a: 1 }]) {
        const worker = await runHandler(formRequest('email=a%40x.com'), { bindings: { VALID_STATUS: bad }, status: 'invalid' });
        assert.strictEqual(worker.text, 'email=a%40x.com');
        assert.strictEqual(worker.logs.filter((line) => line.startsWith('Ignoring VALID_STATUS')).length, 1);
    }
});

// --- field names the way PHP reads them -----------------------------------

test('R2 bypass: every url-encoded field whose name contains email is an email field, whatever the origin makes of the name', async () => {
    const good = 'email=g%40ok.example';
    const evil = 'e%40bad.example';
    for (const name of ['%20email', '+email', '%09email', 'email%00x', 'email%00', 'your.email', 'your+email', 'your_email', '%20your-email', 'email', '%20%20email', '%3Femail', '?email', 'email%20', 'xemail', 'email.x', 'EMAIL', 'Your[Email', 'email[]', 'em%61il', 'e.email']) {
        const { calls, text } = await runHandler(formRequest(`${good}&${name}=${evil}`), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['g@ok.example'], name);
        assert.strictEqual(text, `${good}&${name}=INVALID`, name);
    }
    // No "email" in the name, decoded or raw: not an email field, and not read when a named field exists.
    for (const name of ['e.mail', 'e%2Dmail', 'mail', 'em%2Bail']) {
        const { calls, text } = await runHandler(formRequest(`${good}&${name}=${evil}`), { status: 'valid' });
        assert.strictEqual(calls.validation.length, 1, name);
        assert.strictEqual(text, `${good}&${name}=${evil}`, name);
    }
});

test('R2 bypass: an alias alone is the field that is validated', async () => {
    const { calls, text } = await runHandler(formRequest('your.email=a%40x.com&n=1'), { status: 'invalid' });
    assert.deepStrictEqual(validated(calls), ['a@x.com']);
    assert.strictEqual(text, 'your.email=INVALID&n=1');
});

test('R2 bypass: in fallback mode a repeat of the found field is rewritten, and so is an email field holding another address', async () => {
    const { calls, text } = await runHandler(formRequest('contact=a%40x.com&contact=b%40x.com&c.ontact=c%40x.com'), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['a@x.com']);
    assert.strictEqual(text, 'contact=a%40x.com&contact=INVALID&c.ontact=c%40x.com');
    // An email field is found before the fallback, so it is the one validated.
    const named = await runHandler(formRequest('contact=a%40x.com&notemail=c%40x.com'), { status: 'valid' });
    assert.deepStrictEqual(validated(named.calls), ['c@x.com']);
});

test('R2 bypass: multipart names are matched the way PHP reads them', async () => {
    for (const name of [' email', 'your.email', 'your email', '\temail']) {
        const body = mpBody(field('email', 'g@ok.example'), field(name, 'e@bad.example'));
        const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['g@ok.example'], JSON.stringify(name));
        assert.strictEqual(text, mpBody(field('email', 'g@ok.example'), field(name, 'INVALID')), JSON.stringify(name));
    }
});

// --- multipart bypasses -----------------------------------------------------

test('R2 bypass: a part named like an email field with a bare filename is a text field; with a filename value it is a file', async () => {
    // A bare `filename` (no "=") is a text field to PHP: still a candidate.
    const bare = mpBody(field('email', 'g@ok.example'), disp('name="email"; filename', 'e@bad.example'));
    const r = await runHandler(mpRequest(bare), { status: 'valid' });
    assert.deepStrictEqual(validated(r.calls), ['g@ok.example']);
    assert.strictEqual(r.text, mpBody(field('email', 'g@ok.example'), disp('name="email"; filename', 'INVALID')));
    // A filename with a value, even an empty one, is a file: never read, never rewritten.
    for (const extra of ['filename=""', 'filename="a.txt"', 'filename=a.txt', 'FILENAME="a"']) {
        const body = mpBody(field('email', 'g@ok.example'), disp(`name="email"; ${extra}`, 'e@bad.example'));
        const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['g@ok.example'], extra);
        assert.strictEqual(text, body, extra);
    }
    // filename*=, filename*0*= and a blank before "=" are text fields to PHP: rewritten like any email field.
    for (const extra of ["filename*=UTF-8''a.txt", "filename*0*=UTF-8''a", 'filename*=', 'filename ="a"', 'filename\t="a"']) {
        const body = mpBody(field('email', 'g@ok.example'), disp(`name="email"; ${extra}`, 'e@bad.example'));
        const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['g@ok.example'], extra);
        assert.strictEqual(text, mpBody(field('email', 'g@ok.example'), disp(`name="email"; ${extra}`, 'INVALID')), extra);
    }
    // Alone, such a part is not validated.
    const alone = mpBody(disp('name="email"; filename="a.txt"', 'a@x.com'));
    assert.strictEqual((await runHandler(mpRequest(alone), { status: 'valid' })).calls.validation.length, 0);
    // A bare filename alone is validated.
    const bareAlone = mpBody(disp('name="email"; filename', 'a@x.com'));
    assert.deepStrictEqual(validated((await runHandler(mpRequest(bareAlone), { status: 'valid' })).calls), ['a@x.com']);
    // A file part with another name stays unread; a bare filename is a text field judged as any other.
    const other = mpBody(disp('name="doc"; filename="a.txt"', 'a@x.com'), disp('name="your-doc"; filename="a"', 'b@x.com'));
    assert.strictEqual((await runHandler(mpRequest(other))).calls.validation.length, 0);
    const bareOther = mpBody(disp('name="doc"; filename', 'a@x.com'));
    assert.deepStrictEqual(validated((await runHandler(mpRequest(bareOther), { status: 'valid' })).calls), ['a@x.com']);
});

test('R2 bypass: a part with two Content-Disposition headers is malformed (PHP reads the first, undici the last)', async () => {
    const twice = (a, b, value) => `Content-Disposition: form-data; ${a}\r\nContent-Disposition: form-data; ${b}\r\n\r\n${value}`;
    for (const [a, b] of [['name="note"', 'name="email"'], ['name="email"', 'name="note"'], ['name="email"; filename="a"', 'name="email"'], ['name="email"', 'name="email"; filename="a"']]) {
        const body = mpBody(field('email', 'g@ok.example'), twice(a, b, 'e@bad.example'));
        const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
        const response = await worker.context.handleRequest(fetchEvent(mpRequest(body)));
        assert.strictEqual(response.status, 400, `${a} ${b}`);
        assert.strictEqual(worker.calls.forwarded.length, 0);
        assert.strictEqual(worker.calls.validation.length, 0);
    }
});

test('R2: a part whose header mentions email is an email field even when its first name parameter is another', async () => {
    const body = mpBody(field('email', 'q@x.com'), 'Content-Disposition: form-data; name="x"; name="email"\r\n\r\np@x.com');
    const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['q@x.com']);
    assert.strictEqual(text, mpBody(field('email', 'q@x.com'), 'Content-Disposition: form-data; name="x"; name="email"\r\n\r\nINVALID'));
});

test('R2: parameter names are case-insensitive, unquoted values are trimmed, quoted ones unescape', async () => {
    // A second part carries the variant name; it must be read as an email field and rewritten.
    for (const header of ['NAME="email"', 'Name=email', 'name=email ; x=y', 'name= email', 'x="a\\"; name=y"; name="email"', 'x="a;b"; name="email"', 'name="em\\ail"', 'name="email" ; x=y']) {
        const body = mpBody(field('email', 'g@ok.example'), `Content-Disposition: form-data; ${header}\r\n\r\ne@bad.example`);
        const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
        assert.strictEqual(calls.validation.length, 1, header);
        assert.strictEqual(text, mpBody(field('email', 'g@ok.example'), `Content-Disposition: form-data; ${header}\r\n\r\nINVALID`), header);
    }
    // A header name is trimmed; its case does not matter.
    const lower = mpBody(field('email', 'g@ok.example'), 'content-disposition: form-data; name="email"\r\n\r\ne@bad.example');
    assert.strictEqual((await runHandler(mpRequest(lower), { status: 'valid' })).text, mpBody(field('email', 'g@ok.example'), 'content-disposition: form-data; name="email"\r\n\r\nINVALID'));
});

test('R2 bypass: the boundary parameter is parsed as a header parameter', async () => {
    const body = rawMp('zb-b', field('email', 'g@ok.example'), field('your-email', 'e@bad.example'));
    const fixed = rawMp('zb-b', field('email', 'g@ok.example'), field('your-email', 'INVALID'));
    for (const type of [
        'multipart/form-data; boundary="zb-b"',
        'multipart/form-data;boundary=zb-b',
        'multipart/form-data; BOUNDARY=zb-b; charset=utf-8',
        'multipart/form-data; charset="a;b"; boundary=zb-b',
    ]) {
        const { calls, text } = await runHandler(multipartRequest(body, type), { status: 'valid' });
        assert.strictEqual(calls.validation.length, 1, type);
        assert.strictEqual(text, fixed, type);
    }
    // No boundary mentioned at all: nothing is read, the request is forwarded.
    // (A header that mentions boundary without a plain parameter is answered 400.)
    for (const type of ['multipart/form-data', 'multipart/form-data; charset=utf-8']) {
        const { calls, text } = await runHandler(multipartRequest(body, type), { status: 'valid' });
        assert.strictEqual(calls.validation.length, 0, type);
        assert.strictEqual(text, body, type);
    }
});

test('R2 bypass: more than one boundary parameter is answered 400 by the Worker, with no origin call', async () => {
    const body = rawMp('zb-b', field('email', 'g@ok.example'));
    for (const type of ['multipart/form-data; x="; boundary=A"; boundary=zb-b', 'multipart/form-data; x="a\\"; boundary=A"; boundary=zb-b', 'multipart/form-data; x="boundary=A"; boundary=zb-b', 'multipart/form-data; xboundary=A; boundary=zb-b', 'multipart/form-data; boundary*=utf-8\'\'A; boundary=zb-b', 'multipart/form-data; boundary=zb-b; BOUNDARY=zb-b', 'multipart/form-data; boundary=zb-b; boundary=other', 'multipart/form-data; boundary=zb-b; BOUNDARY="zb-b"', 'multipart/form-data; boundary=a; x=y; boundary=']) {
        const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
        const response = await worker.context.handleRequest(fetchEvent(multipartRequest(body, type)));
        assert.strictEqual(response.status, 400, type);
        assert.strictEqual(await response.text(), 'Bad Request');
        assert.match(response.headers.get('content-type'), /^text\/plain/);
        assert.strictEqual(worker.calls.forwarded.length, 0);
        assert.strictEqual(worker.calls.validation.length, 0);
        assert.strictEqual(worker.errors.length, 1);
    }
});

test('a header that mentions boundary but has no boundary parameter is answered 400', async () => {
    // PHP finds "boundary" anywhere in the header and reads the body; the Worker would not.
    const body = rawMp('B', field('email', 'e@bad.example'));
    for (const type of ["multipart/form-data; boundary*=B", 'multipart/form-data; xboundary=B', 'multipart/form-data; boundaryx=B', 'multipart/form-data; x="boundary=B"']) {
        const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
        const response = await worker.context.handleRequest(fetchEvent(multipartRequest(body, type)));
        assert.strictEqual(response.status, 400, type);
        assert.strictEqual(worker.calls.forwarded.length, 0, type);
        assert.strictEqual(worker.calls.validation.length, 0, type);
    }
    // A multipart header with no mention of boundary at all is forwarded unread, as before.
    const { calls, text } = await runHandler(multipartRequest(body, 'multipart/form-data'), { status: 'valid' });
    assert.strictEqual(calls.validation.length, 0);
    assert.strictEqual(text, body);
});

test('a long run of blanks inside a field value is trimmed in linear time', async () => {
    // A regex trim (/^\s+|\s+$/g) is quadratic on a run of blanks that does not reach the end.
    const blanks = '+'.repeat(200000);
    const started = Date.now();
    await runHandler(formRequest(`note=a${blanks}b&email2=x%40${blanks}y&email=g%40ok.example`), { status: 'valid' });
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('R2 bypass: a delimiter line is the boundary and nothing else but blanks and a line break', async () => {
    // "--zb-b-Z" inside a value is not a delimiter, so the fake part stays inside "note".
    const note = field('note', 'x\r\n--zb-b-Z\r\nContent-Disposition: form-data; name="email"\r\n\r\ne@bad.example');
    const body = mpBody(note, field('email', 'g@ok.example'));
    const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['g@ok.example']);
    assert.strictEqual(text, body);

    // Trailing spaces and tabs after the boundary, a bare LF, and a body that ends at the closing delimiter.
    const variants = [
        `--zb-b \t\r\n${field('email', 'g@ok.example')}\r\n--zb-b  \r\n${field('n', '1')}\r\n--zb-b--`,
        `--zb-b\n${field('email', 'g@ok.example').replace(/\r\n/g, '\n')}\n--zb-b--\n`,
        `--zb-b\r\n${field('email', 'g@ok.example')}\r\n--zb-b--`,
        `preamble\r\n--zb-b\r\n${field('email', 'g@ok.example')}\r\n--zb-b--junk`,
    ];
    for (const variant of variants) {
        const result = await runHandler(mpRequest(variant), { status: 'valid' });
        assert.deepStrictEqual(validated(result.calls), ['g@ok.example'], JSON.stringify(variant));
    }

    // A bare CR is not a line break: no delimiter line exists, and the body is
    // a preamble that holds the boundary, so it is refused.
    const cr = `--zb-b\r${field('email', 'g@ok.example')}\r\n--zb-b--\r\n`;
    const crWorker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    assert.strictEqual((await crWorker.context.handleRequest(fetchEvent(mpRequest(cr)))).status, 400);
    assert.strictEqual(crWorker.calls.validation.length, 0);
});

test('strict multipart: the boundary again after the closing delimiter is answered 400', async () => {
    const epilogue = `--zb-b\r\n${field('n', '1')}\r\n--zb-b--\r\n--zb-b\r\n${field('email', 'e@bad.example')}\r\n--zb-b--\r\n`;
    await assertRefused400(mpRequest(epilogue));
    // The boundary text inside a longer line is still the boundary again.
    await assertRefused400(mpRequest(`--zb-b\r\n${field('n', '1')}\r\n--zb-b--\r\nx--zb-b`));
    // A plain epilogue is fine (browsers send "--B--\r\n").
    for (const tail of ['', '\r\n', '\n', 'epilogue text\r\n', '--zb', '-- zb-b']) {
        const body = `--zb-b\r\n${field('email', 'g@ok.example')}\r\n--zb-b--${tail}`;
        const { calls } = await runHandler(mpRequest(body), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['g@ok.example'], JSON.stringify(tail));
    }
});

test('strict multipart: a part with no blank line after its headers is answered 400', async () => {
    await assertRefused400(mpRequest(mpBody('Content-Disposition: form-data; name="email"\r\nc@x.com')));
    await assertRefused400(mpRequest(mpBody(field('n', '1'), 'Content-Disposition: form-data; name="x"')));
});

test('strict multipart: no closing delimiter is answered 400', async () => {
    await assertRefused400(mpRequest(`--zb-b\r\n${field('email', 'g@ok.example')}\r\n`));
    await assertRefused400(mpRequest(`--zb-b\r\n${field('email', 'g@ok.example')}`));
    await assertRefused400(mpRequest(`--zb-b\r\n${field('email', 'g@ok.example')}\r\n--zb-bx\r\n`));
    await assertRefused400(mpRequest('email=a%40x.com'));
    await assertRefused400(mpRequest(''));
    await assertRefused400(mpRequest('--zb-b'));
});

test('strict multipart: a header line that is not "Name: value" or a fold, or holds NUL or a bare CR, is answered 400', async () => {
    const bad = [
        'Content-Disposition: form-data; name="email"\r\njunk line\r\n\r\na@x.com',
        'Content-Disposition: form-data; name="email"\r\n: nameless\r\n\r\na@x.com',
        'Content-Disposition: form-data; name="email"\r\nX Y: spaced name\r\n\r\na@x.com',
        'Content-Disposition : form-data; name="email"\r\n\r\na@x.com',
        'Content-Disposition: form-data; name="email"\r\nX-A: b\0c\r\n\r\na@x.com',
        'Content-Disposition: form-data; name="em\0ail"\r\n\r\na@x.com',
        'Content-Disposition: form-data; name="email"\r\nX-A: b\rc\r\n\r\na@x.com',
        'junk\r\nContent-Disposition: form-data; name="email"\r\n\r\na@x.com',
    ];
    for (const part of bad) {
        await assertRefused400(mpRequest(mpBody(field('email', 'g@ok.example'), part)), JSON.stringify(part));
    }
    // Folds (a tab or a space), a header with no space after the colon, and no header line at all are fine.
    const good = [
        'Content-Disposition: form-data;\r\n\tname="email"\r\n\r\na@x.com',
        'Content-Disposition:form-data; name="email"\r\n\r\na@x.com',
        'Content-Disposition: form-data; name="email"\r\nX-Custom_Header.1: v\r\n\r\na@x.com',
        '\r\nplain',
    ];
    for (const part of good) {
        const { calls } = await runHandler(mpRequest(mpBody(part)), { status: 'valid' });
        assert.ok(calls.forwarded.length === 1, JSON.stringify(part));
    }
});

test('strict multipart: a refused body has no API call, no origin call and one error line', async () => {
    const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    const response = await worker.context.handleRequest(fetchEvent(mpRequest(`--zb-b\r\n${field('email', 'g@ok.example')}\r\n`)));
    assert.strictEqual(response.status, 400);
    assert.strictEqual(await response.text(), 'Bad Request');
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.strictEqual(worker.calls.forwarded.length, 0);
    assert.strictEqual(worker.calls.validation.length, 0);
    assert.strictEqual(worker.errors.length, 1);
});

test('strict multipart: bodies as real clients send them are accepted', async () => {
    const part = (name, value, extra = '') => `Content-Disposition: form-data; name="${name}"${extra}\r\n\r\n${value}`;
    const styles = {
        chrome: ['----WebKitFormBoundaryAbC123xyz', (b) => `------WebKitFormBoundaryAbC123xyz\r\n${part('email', 'g@ok.example')}\r\n------WebKitFormBoundaryAbC123xyz\r\n${part('f', 'bin', '; filename="a.png"\r\nContent-Type: image/png')}\r\n------WebKitFormBoundaryAbC123xyz--\r\n`],
        firefox: ['---------------------------123456789012345678901234567', () => `-----------------------------123456789012345678901234567\r\n${part('email', 'g@ok.example')}\r\n-----------------------------123456789012345678901234567--\r\n`],
        curl: ['------------------------abcdef0123456789', () => `--------------------------abcdef0123456789\r\n${part('email', 'g@ok.example')}\r\n--------------------------abcdef0123456789\r\n${part('f', 'x', '; filename="a.txt"\r\nContent-Type: text/plain')}\r\n--------------------------abcdef0123456789--\r\n`],
        python: ['a1b2c3d4e5f60718293a4b5c6d7e8f90', () => `--a1b2c3d4e5f60718293a4b5c6d7e8f90\r\n${part('email', 'g@ok.example')}\r\n--a1b2c3d4e5f60718293a4b5c6d7e8f90\r\n${part('f', 'x', '; filename="a.txt"')}\r\n--a1b2c3d4e5f60718293a4b5c6d7e8f90--\r\n`],
        phpcurl: ['------------------------0123456789abcdef', () => `--------------------------0123456789abcdef\r\nContent-Disposition: form-data; name="email"\r\n\r\ng@ok.example\r\n--------------------------0123456789abcdef--\r\n`],
        undici: ['----formdata-undici-012345678901', () => `------formdata-undici-012345678901\r\nContent-Disposition: form-data; name="email"\r\n\r\ng@ok.example\r\n------formdata-undici-012345678901\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nx\r\n------formdata-undici-012345678901--\r\n`],
        go: ['0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab', () => `--0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab\r\nContent-Disposition: form-data; name="email"\r\n\r\ng@ok.example\r\n--0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab--\r\n`],
    };
    for (const [style, [boundary, make]] of Object.entries(styles)) {
        const body = make(boundary);
        const { calls, text } = await runHandler(multipartRequest(body, `multipart/form-data; boundary=${boundary}`), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['g@ok.example'], style);
        assert.strictEqual(text, body, style);
    }
});

test('strict multipart: a malformed-body scan over 200k bytes of blanks, CR, LF, dashes, colons and NUL takes linear time', async () => {
    for (const filler of [' ', '\r', '\n', '-', ':', '\0', '"', '\r\n', '--zb-b', '-\r\n']) {
        const run = filler.repeat(Math.ceil(200000 / filler.length));
        const shapes = [
            `--zb-b\r\nContent-Disposition: form-data; name="email"\r\n${run}\r\n\r\na@x.com\r\n--zb-b--\r\n`,
            `--zb-b\r\n${run}`,
            `--zb-b\r\n${field('n', run)}\r\n--zb-b--\r\n${run}`,
            `${run}--zb-b\r\nX: ${run}\r\n\r\n${run}`,
        ];
        for (const body of shapes) {
            const started = Date.now();
            const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
            await worker.context.handleRequest(fetchEvent(mpRequest(body)));
            assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms for ${JSON.stringify(filler)}`);
        }
    }
});

test('R2 bypass: a candidate part with a transfer encoding is rewritten to INVALID when VALID_STATUS is set', async () => {
    const qp = (name, value, encoding = 'quoted-printable') => disp(`name="${name}"`, value, `Content-Transfer-Encoding: ${encoding}\r\n`);
    // Beside a validated address: still one validation, the encoded value goes.
    for (const encoding of ['quoted-printable', 'base64', 'Base64', 'x-token']) {
        const body = mpBody(field('email', 'g@ok.example'), qp('your-email', 'e=40bad.example', encoding));
        const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['g@ok.example'], encoding);
        assert.strictEqual(text, mpBody(field('email', 'g@ok.example'), qp('your-email', 'INVALID', encoding)), encoding);
    }
    // Alone: no validation call, rewritten all the same.
    const alone = mpBody(qp('email', 'e=40bad.example'), field('note', 'hi'));
    const result = await runHandler(mpRequest(alone), { status: 'valid' });
    assert.strictEqual(result.calls.validation.length, 0);
    assert.strictEqual(result.text, mpBody(qp('email', 'INVALID'), field('note', 'hi')));
    // Identity encodings, other field names, an empty value, no VALID_STATUS and a failed validation leave it as it is.
    for (const encoding of ['7bit', '8BIT', 'binary']) {
        const body = mpBody(field('email', 'g@ok.example'), qp('your-email', 'g@ok.example', encoding));
        assert.strictEqual((await runHandler(mpRequest(body), { status: 'valid' })).text, body, encoding);
    }
    const note = mpBody(field('email', 'g@ok.example'), qp('note', 'e=40bad.example'));
    assert.strictEqual((await runHandler(mpRequest(note), { status: 'valid' })).text, note);
    const empty = mpBody(field('email', 'g@ok.example'), qp('your-email', ''));
    assert.strictEqual((await runHandler(mpRequest(empty), { status: 'valid' })).text, empty);
    const body = mpBody(field('email', 'g@ok.example'), qp('your-email', 'e=40bad.example'));
    assert.strictEqual((await runHandler(mpRequest(body), { status: 'valid', bindings: { VALID_STATUS: undefined } })).text, body);
    assert.strictEqual((await runHandler(mpRequest(body), { status: 'valid', bindings: { API_KEY: 'bad key' } })).text, body);
});

test('R2 bypass: a transfer-encoded candidate part is never chosen as the address', async () => {
    const body = mpBody(disp('name="email"', 'a@x.com', 'Content-Transfer-Encoding: base64\r\n'), field('contact', 'c@x.com'));
    const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['c@x.com']);
    assert.strictEqual(text, mpBody(disp('name="email"', 'INVALID', 'Content-Transfer-Encoding: base64\r\n'), field('contact', 'c@x.com')));
});

// --- JSON -------------------------------------------------------------------

function jsonRequest(form, extra = {}) {
    return new Request('https://example.com/f', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ form: JSON.stringify(form), ...extra }),
    });
}

test('R2 bypass: a JSON candidate key whose value is not a string is set to INVALID when VALID_STATUS is set', async () => {
    for (const value of [123, ['a@x.com'], null, { a: 'b@x.com' }, true]) {
        const alone = await runHandler(jsonRequest({ email: value, n: 1 }), { status: 'valid' });
        assert.strictEqual(alone.calls.validation.length, 0);
        assert.deepStrictEqual(JSON.parse(JSON.parse(alone.text).form), { email: 'INVALID', n: 1 });

        const beside = await runHandler(jsonRequest({ email: value, 'your-email': 'g@ok.example' }), { status: 'valid' });
        assert.deepStrictEqual(validated(beside.calls), ['g@ok.example']);
        assert.deepStrictEqual(JSON.parse(JSON.parse(beside.text).form), { email: 'INVALID', 'your-email': 'g@ok.example' });

        const unset = await runHandler(jsonRequest({ email: value }), { status: 'valid', bindings: { VALID_STATUS: undefined } });
        assert.deepStrictEqual(JSON.parse(JSON.parse(unset.text).form), { email: value });
    }
    // Another key that contains email counts, one without it does not.
    const other = await runHandler(jsonRequest({ email2: 5, note: 6 }), { status: 'valid' });
    assert.deepStrictEqual(JSON.parse(JSON.parse(other.text).form), { email2: 'INVALID', note: 6 });
});

// --- small survivors --------------------------------------------------------

test('R2: the media type is trimmed, and empty fields are skipped', async () => {
    const trimmed = new Request('https://example.com/f', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded ; charset=utf-8' },
        body: 'email=a%40x.com',
    });
    assert.strictEqual((await runHandler(trimmed)).text, 'email=INVALID');
    const mp = new Request('https://example.com/f', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data ; boundary=zb-b' },
        body: mpBody(field('email', 'a@x.com')),
    });
    assert.strictEqual((await runHandler(mp)).text, mpBody(field('email', 'INVALID')));

    const { calls, text } = await runHandler(formRequest('x=1&&&email=a%40x.com&&'), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['a@x.com']);
    assert.strictEqual(text, 'x=1&&&email=a%40x.com&&');
});

test('R2: a value is trimmed before it is judged and before it is compared with the validated address', async () => {
    const { calls, text } = await runHandler(formRequest('email=%20a%40x.com%20'), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['a@x.com']);
    assert.strictEqual(text, 'email=%20a%40x.com%20');
    const same = await runHandler(formRequest('email=a%40x.com&email=%20a%40x.com%20&your-email=%0Aa%40x.com'), { status: 'valid' });
    assert.strictEqual(same.text, 'email=a%40x.com&email=%20a%40x.com%20&your-email=%0Aa%40x.com');
});

test('R2: the forwarded request keeps its URL, query string and method after a rewrite', async () => {
    const request = formRequest('email=a%40x.com', { url: 'https://example.com/path/sub?x=1&y=%20z' });
    const worker = await runHandler(request);
    assert.strictEqual(worker.text, 'email=INVALID');
    assert.strictEqual(worker.calls.forwarded[0].url, 'https://example.com/path/sub?x=1&y=%20z');
    assert.strictEqual(worker.calls.forwarded[0].method, 'POST');
});

// --- errors -----------------------------------------------------------------

test('R2: a 2xx error body names its message; a whitespace-only error string is not an error', async () => {
    const answer = async (body, status = 200) => {
        const { context } = loadWorker({ API_KEY });
        context.fetch = async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        const result = await context.validateEmail('a@x.com', null);
        return typeof result === 'string' ? JSON.parse(result).message : result;
    };
    assert.strictEqual(await answer({ detail: 'the detail' }), 'the detail');
    assert.strictEqual(await answer({ message: ' the message ' }), 'the message');
    assert.strictEqual(await answer({ Message: 'M' }), 'M');
    assert.strictEqual(await answer({ error_message: 'em' }), 'em');
    assert.strictEqual(await answer({ Error: 'E', status: 'valid', address: 'a@x.com' }), 'E');
    assert.strictEqual(await answer({ detail: '   ', message: 'second' }), 'second');
    assert.strictEqual(await answer({ detail: 5 }), 'ZeroBounce returned no validation status.');
    assert.strictEqual(await answer([{ error: 'inside' }]), 'ZeroBounce returned an unexpected response.');
    assert.strictEqual(await answer('"text"'), 'ZeroBounce returned an unexpected response.');
    assert.strictEqual(await answer('null'), 'ZeroBounce returned an unexpected response.');
    assert.strictEqual(await answer({ detail: 'from a 500' }, 500), 'from a 500');
    assert.strictEqual(await answer([1], 500), 'ZeroBounce returned an unexpected response.');
    assert.strictEqual(await answer('not json', 500), 'ZeroBounce answered with HTTP 500');
    // Whitespace-only error strings do not make a result an error.
    for (const key of ['error', 'error_message', 'Error']) {
        const result = await answer({ status: 'valid', address: 'a@x.com', [key]: '  \t ' });
        assert.strictEqual(result.status, 'valid', key);
    }
});

// --- KV, logs, redaction ----------------------------------------------------

test('R2: KV key time fields are zero-padded, with no commas', async () => {
    class FixedDate extends Date {
        constructor() { super(2026, 0, 2, 3, 4, 5, 6); }
    }
    const kv = recordingKv();
    const worker = loadWorker({ API_KEY, LOGS: kv.LOGS, Date: FixedDate });
    const events = [];
    worker.context.logValidation({ waitUntil: (p) => events.push(p) }, 'a@x.com', '/p', { status: 'valid' });
    await Promise.all(events);
    assert.strictEqual(kv.puts[0].key, '{2026-01-02}-{a@x.com}-{/p}-{03:04}-05.006');
});

test('R2: a LOGS.put that throws at once does not stop the request, and the rewrite still happens', async () => {
    const throwing = { put: () => { throw new Error('boom'); } };
    const worker = await runHandler(formRequest('email=a%40x.com&n=1'), { bindings: { LOGS: throwing }, status: 'invalid' });
    assert.strictEqual(worker.text, 'email=INVALID&n=1');
    assert.ok(worker.errors.some((line) => line.includes('boom')), worker.errors.join('\n'));

    const notKv = await runHandler(formRequest('email=a%40x.com'), { bindings: { LOGS: 'not a namespace' }, status: 'invalid' });
    assert.strictEqual(notKv.text, 'email=INVALID');
    assert.ok(notKv.errors.length >= 1);
});

test('R2: a refused whitespace-only API_KEY is not used for masking', async () => {
    for (const key of [' ', '   ', '\t', '\n ']) {
        const worker = loadWorker({ API_KEY: key });
        assert.strictEqual(worker.context.redactKey('a b\tc d'), 'a b\tc d', JSON.stringify(key));
        const result = await worker.context.validateEmail('a@x.com', null);
        assert.strictEqual(worker.calls.validation.length, 0);
        assert.match(JSON.parse(result).error, /Invalid API_KEY/);
        assert.ok(worker.errors.every((line) => line.includes('Invalid API_KEY')), worker.errors.join('\n'));
    }
});

test('R2: log lines pass through the redaction', async () => {
    const KEY = 'zb-dummy-key-0001';
    const worker = loadWorker({ API_KEY: KEY, API_REGION: `moon-${KEY}` });
    await worker.context.validateEmail('a@x.com', null);
    assert.ok(worker.logs.some((line) => line.includes('Unknown API_REGION')));
    for (const line of [...worker.logs, ...worker.errors]) assert.ok(!line.includes(KEY), line);

    const bad = loadWorker({ API_KEY: KEY });
    bad.context.logLine(`seen ${KEY}`);
    bad.context.errorLine(`seen ${KEY}`);
    assert.deepStrictEqual(bad.logs, ['seen ***']);
    assert.deepStrictEqual(bad.errors, ['seen ***']);
});

test('R2: the KV key never carries the API key, in the address or the path part, and redaction comes before the cut', async () => {
    const KEY = 'zb-dummy-key-0001';
    const store = async (email, url) => {
        const kv = recordingKv();
        const worker = loadWorker({ API_KEY: KEY, LOGS: kv.LOGS });
        const events = [];
        worker.context.logValidation({ waitUntil: (p) => events.push(p) }, email, url, { status: 'valid' });
        await Promise.all(events);
        return kv.puts[0].key;
    };
    assert.ok(!(await store(`${KEY}@x.com`, '/p')).includes(KEY));
    assert.ok((await store(`${KEY}@x.com`, '/p')).includes('***@x.com'));
    assert.ok(!(await store('a@x.com', `/${KEY}`)).includes(KEY));
    assert.ok((await store('a@x.com', `/${KEY}`)).includes('/***'));

    // The key straddles the cut: found whole in the text, so masked before the text is cut.
    for (const build of [(pad) => store(`${'a'.repeat(pad)}${KEY}@x.com`, '/p'), (pad) => store('a@x.com', `/${'p'.repeat(pad * 2)}${KEY}`)]) {
        for (let pad = 150; pad < 300; pad += 1) {
            const key = await build(pad);
            assert.ok(!key.includes(KEY.slice(0, 8)), `pad ${pad}: ${key}`);
        }
    }
});

test('R2: a very long address cannot push the KV key over 512 bytes', async () => {
    const kv = recordingKv();
    const worker = loadWorker({ API_KEY, LOGS: kv.LOGS });
    const events = [];
    worker.context.logValidation({ waitUntil: (p) => events.push(p) }, `${'a'.repeat(600)}@x.com`, '/p', { status: 'valid' });
    await Promise.all(events);
    assert.ok(new TextEncoder().encode(kv.puts[0].key).length <= 512);
    assert.match(kv.puts[0].key, /\}-\{\/p\}-\{\d\d:\d\d\}-\d\d\.\d{3}$/);
});

test('R2: a bare CR after the boundary is not a delimiter', async () => {
    const body = `--zb-b\r\n${field('email', 'g@ok.example')}\r\n--zb-b\rjunk\r\n${field('your-email', 'e@bad.example')}\r\n--zb-b--\r\n`;
    const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
    // Everything up to the next real delimiter is one value, which holds an "@" without being an
    // address: it is never sent to the API and, in an email field, becomes INVALID.
    assert.strictEqual(calls.validation.length, 0);
    assert.strictEqual(text, `--zb-b\r\n${field('email', 'INVALID')}\r\n--zb-b--\r\n`);
});

test('R2: a part without Content-Disposition is skipped, and white space around parameters is tolerated', async () => {
    const noDisposition = 'Content-Type: text/plain\r\n\r\ne@bad.example';
    const body = mpBody(noDisposition, field('email', 'g@ok.example'));
    const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['g@ok.example']);
    assert.strictEqual(text, body);

    for (const header of ['name ="email"', 'name= "email"', 'name = "email"', 'form-data;\tname="email"', 'x=1;   name="email"']) {
        const variant = `Content-Disposition: form-data; ${header}\r\n\r\ne@bad.example`;
        const result = await runHandler(mpRequest(mpBody(field('email', 'g@ok.example'), variant)), { status: 'valid' });
        assert.strictEqual(result.text, mpBody(field('email', 'g@ok.example'), variant.replace('e@bad.example', 'INVALID')), header);
    }
});

test('R2: nothing is forwarded as a modified request when nothing is rewritten', async () => {
    const mp = mpBody(field('email', 'g@ok.example'));
    const urlenc = 'email=g%40ok.example';
    const json = jsonRequest({ email: 'g@ok.example' });
    for (const request of [mpRequest(mp), formRequest(urlenc), json]) {
        const { logs } = await runHandler(request, { status: 'valid' });
        assert.ok(!logs.some((line) => line.includes('Returning modified request')));
    }
    for (const request of [mpRequest(mp), formRequest(urlenc), jsonRequest({ email: 'g@ok.example' })]) {
        const { logs } = await runHandler(request, { status: 'invalid' });
        assert.ok(logs.some((line) => line.includes('Returning modified request')));
    }
});

test('R2: a transfer-encoded candidate part is left alone when VALID_STATUS is not set, even with no address elsewhere', async () => {
    const body = mpBody(disp('name="email"', 'e=40bad.example', 'Content-Transfer-Encoding: quoted-printable\r\n'), field('note', 'hi'));
    const { calls, text } = await runHandler(mpRequest(body), { status: 'valid', bindings: { VALID_STATUS: undefined } });
    assert.strictEqual(calls.validation.length, 0);
    assert.strictEqual(text, body);
    const json = await runHandler(jsonRequest({ email: 5 }), { status: 'valid', bindings: { VALID_STATUS: undefined } });
    assert.deepStrictEqual(JSON.parse(JSON.parse(json.text).form), { email: 5 });
});

test('R2: a trailing comma and the space before it are dropped from a typed entry', async () => {
    const { text } = await runHandler(formRequest('email=a%40x.com'), { bindings: { VALID_STATUS: ['valid ,'] }, status: 'valid' });
    assert.strictEqual(text, 'email=a%40x.com');
});

// --- binding lists: the formats zerobounce.net's guide prints -----------------

test('R3 HIGH: VALID_STATUS and BYPASS_PATH read the guide curly-quoted lists and other loose spellings', async () => {
    const sent = 'email=a%40x.com';
    const guide = '[‘valid’, ‘catch-all’, ‘unknown’]';
    const accepted = [
        guide,
        "['valid', 'catch-all', 'unknown']",
        '[valid, catch-all]',
        'valid;catch-all',
        'valid|catch-all',
        "valid, 'catch-all'",
        '"valid catch-all"',
        '“valid” «catch-all»',
        '`valid`,`catch-all`',
        ['‘valid’', '‘catch-all’,'],
        ' [ "valid" , "catch-all" ] ',
    ];
    for (const VALID_STATUS of accepted) {
        for (const status of ['valid', 'catch-all']) {
            const w = await runHandler(formRequest(sent), { bindings: { VALID_STATUS }, status });
            assert.strictEqual(w.text, sent, `${JSON.stringify(VALID_STATUS)} ${status}`);
            assert.ok(!w.logs.some((line) => line.startsWith('Ignoring')), JSON.stringify(VALID_STATUS));
        }
        const w = await runHandler(formRequest(sent), { bindings: { VALID_STATUS }, status: 'invalid' });
        assert.strictEqual(w.text, 'email=INVALID', JSON.stringify(VALID_STATUS));
    }
    // The guide's unknown is in its list.
    const w = await runHandler(formRequest(sent), { bindings: { VALID_STATUS: guide }, status: 'unknown' });
    assert.strictEqual(w.text, sent);

    const guidePaths = '‘/login,’ ‘/logout,’ ‘/connect,’ ‘/signing’';
    for (const [BYPASS_PATH, path, bypassed] of [
        [guidePaths, '/login', true], [guidePaths, '/logout', true], [guidePaths, '/connect', true], [guidePaths, '/signing', true],
        [guidePaths, '/Login', false], [guidePaths, '/login,', false],
        ["'/login,' '/logout,' '/connect,' '/signing'", '/logout', true],
        ['/a;/b|/c', '/c', true],
        ['[/a, /b]', '/a', true],
    ]) {
        const { calls } = await runHandler(formRequest(sent, { url: `https://example.com${path}` }), { bindings: { BYPASS_PATH } });
        assert.strictEqual(calls.validation.length, bypassed ? 0 : 1, `${JSON.stringify(BYPASS_PATH)} ${path}`);
    }
});

test('R3 HIGH: an unknown status in VALID_STATUS is logged once and dropped; a list with none left counts as not set', async () => {
    const sent = 'email=a%40x.com';
    // catch_all (underscore) is not an API status.
    const one = await runHandler(formRequest(sent), { bindings: { VALID_STATUS: 'valid, catch_all' }, status: 'catch-all' });
    assert.strictEqual(one.text, 'email=INVALID');
    assert.strictEqual(one.logs.filter((line) => line.startsWith('Ignoring unknown status')).length, 1);
    assert.ok(one.logs.some((line) => line.includes('catch_all')));

    // Every entry unknown: the binding is not set, so nothing is rewritten, and it is logged.
    const none = await runHandler(formRequest(sent), { bindings: { VALID_STATUS: 'catch_all' }, status: 'invalid' });
    assert.strictEqual(none.text, sent);
    assert.strictEqual(none.logs.filter((line) => line.startsWith('Ignoring unknown status')).length, 1);
    assert.strictEqual(none.logs.filter((line) => line.startsWith('Ignoring VALID_STATUS')).length, 1);

    // The log line never carries the API key.
    const keyed = await runHandler(formRequest(sent), { bindings: { VALID_STATUS: `valid, ${API_KEY}` }, status: 'valid' });
    for (const line of keyed.logs) assert.ok(!line.includes(API_KEY), line);

    // Blank: not set, logged.
    for (const blank of ['', '   ', '[]', "[ ]", '‘’']) {
        const w = await runHandler(formRequest(sent), { bindings: { VALID_STATUS: blank }, status: 'invalid' });
        assert.strictEqual(w.text, sent, JSON.stringify(blank));
        assert.strictEqual(w.logs.filter((line) => line.startsWith('Ignoring VALID_STATUS')).length, 1, JSON.stringify(blank));
    }
});

// --- R3: the email-field rule (any field whose name or part header contains "email") ---

/** Like fetchEvent, but keeps what is handed to waitUntil, so a test can await it. */
function waitingEvent(request) {
    const waits = [];
    return { event: { request, waitUntil: (p) => waits.push(p), passThroughOnException: () => {} }, waits };
}

const GOOD = 'good@ok.example';
const EVIL = 'evil@bad.example';
const C = '\r\n';
const mpPart = (header, value) => `${header}${C}${C}${value}${C}`;
const mpGood = (b) => `--${b}${C}` + mpPart('Content-Disposition: form-data; name="email"', GOOD);
const mpAll = (b, ...parts) => parts.join('') + `--${b}--${C}`;

test('R3 e2e: no address other than the validated one stays in a field or part whose name or header contains email', async () => {
    const B = 'B';
    const cases = [
        // [name, content-type, body, address that must be gone from the forwarded bytes]
        ['disposition without form-data;', mpAll(B, mpGood(B), `--${B}${C}` + mpPart('Content-Disposition: name="email"', EVIL))],
        ['single-quoted name', mpAll(B, mpGood(B), `--${B}${C}` + mpPart("Content-Disposition: form-data; name='email'", EVIL))],
        ['unquoted name and junk', mpAll(B, mpGood(B), `--${B}${C}` + mpPart('Content-Disposition: form-data; name=email junk', EVIL))],
        ['junk after the closing quote', mpAll(B, mpGood(B), `--${B}${C}` + mpPart('Content-Disposition: form-data; name="email"junk', EVIL))],
        ['folded header', mpAll(B, mpGood(B), `--${B}${C}` + mpPart(`Content-Disposition: form-data;${C} name="email"`, EVIL))],
        ['folded header, tab', mpAll(B, mpGood(B), `--${B}${C}` + mpPart(`Content-Disposition: form-data;${C}\tname="email"`, EVIL))],
        ['your[email', mpAll(B, mpGood(B), `--${B}${C}` + mpPart('Content-Disposition: form-data; name="your[email"', EVIL))],
        ['email[', mpAll(B, mpGood(B), `--${B}${C}` + mpPart('Content-Disposition: form-data; name="email["', EVIL))],
        ['escaped quote in the name', mpAll(B, mpGood(B), `--${B}${C}` + mpPart('Content-Disposition: form-data; name="em\\ail"', EVIL))],
        ['an extra header that mentions email', mpAll(B, mpGood(B), `--${B}${C}` + mpPart(`Content-Disposition: form-data; name="x"${C}X-Field: EMAIL`, EVIL))],
        ['LF-only line breaks', `--${B}\nContent-Disposition: form-data; name="email"\n\n${GOOD}\n--${B}\nContent-Disposition: form-data; name="Your-Email"\n\n${EVIL}\n--${B}--\n`],
    ];
    for (const [name, body] of cases) {
        const worker = await runHandler(multipartRequest(body, `multipart/form-data; boundary=${B}`), { status: 'valid' });
        assert.deepStrictEqual(validated(worker.calls), [GOOD], name);
        assert.ok(worker.text.includes(GOOD), name);
        assert.ok(!worker.text.includes(EVIL), name);
    }
    const urlCases = [
        'your_email=good%40ok.example&your[email=evil%40bad.example',
        'email=good%40ok.example&email[]=evil%40bad.example',
        'email=good%40ok.example&%09email=evil%40bad.example',
        'your-email=good%40ok.example&your+email=evil%40bad.example',
        'email=good%40ok.example&email%5B=evil%40bad.example',
        'email=good%40ok.example&EMAIL=evil%40bad.example',
        'email=good%40ok.example&e%6Dail=evil%40bad.example',
        'your_email=good%40ok.example&your.email=evil%40bad.example',
    ];
    for (const body of urlCases) {
        const worker = await runHandler(formRequest(body), { status: 'valid' });
        assert.deepStrictEqual(validated(worker.calls), [GOOD], body);
        assert.ok(!worker.text.includes('evil'), body);
    }
});

test('R3 e2e: a rejected address leaves no address in any email field', async () => {
    const worker = await runHandler(formRequest('Email=a%40x.com&your.email=b%40x.com&notes=c%40x.com&emailCopy=d%40x.com'), { status: 'invalid' });
    assert.strictEqual(worker.calls.validation.length, 1);
    assert.strictEqual(worker.text, 'Email=INVALID&your.email=INVALID&notes=c%40x.com&emailCopy=INVALID');
});

test('R3: the choice - exact name first, then any email field holding an address, then any field; a non-address is never sent', async () => {
    const one = async (body, ct) => {
        const w = ct ? await runHandler(multipartRequest(body, ct), { status: 'valid' }) : await runHandler(formRequest(body), { status: 'valid' });
        return validated(w.calls);
    };
    assert.deepStrictEqual(await one('myemail=a%40x.com&email=b%40x.com'), ['b@x.com']);
    assert.deepStrictEqual(await one('myemail=a%40x.com&your_email=b%40x.com'), ['b@x.com']);
    assert.deepStrictEqual(await one('myemail=a%40x.com&note=b%40x.com'), ['a@x.com']);
    assert.deepStrictEqual(await one('email=junk&note=b%40x.com&myemail=c%40x.com'), ['c@x.com']);
    assert.deepStrictEqual(await one('email=junk&note=b%40x.com'), ['b@x.com']);
    assert.deepStrictEqual(await one('email=junk&note=more'), []);
    assert.deepStrictEqual(await one(mpAll('B', `--B${C}` + mpPart('Content-Disposition: form-data; name="x-email"', 'a@x.com'), mpGood('B')), 'multipart/form-data; boundary=B'), [GOOD]);
});

test('R3: a file part is read only when its header block mentions email', async () => {
    const B = 'B';
    const plain = mpAll(B, `--${B}${C}` + mpPart('Content-Disposition: form-data; name="doc"; filename="a.txt"', GOOD));
    const w = await runHandler(multipartRequest(plain, `multipart/form-data; boundary=${B}`), { status: 'invalid' });
    assert.strictEqual(w.calls.validation.length, 0);
    assert.strictEqual(w.text, plain);
    // Binary file bytes in an email-named file part that are not an address stay as they are.
    const bin = mpAll(B, mpGood(B), `--${B}${C}` + mpPart('Content-Disposition: form-data; name="email"; filename="a.bin"', 'not an address'));
    const kept = await runHandler(multipartRequest(bin, `multipart/form-data; boundary=${B}`), { status: 'valid' });
    assert.strictEqual(kept.text, bin);
});

test('R3: an email part with a transfer encoding is INVALID; a header block mentioning email is read case-insensitively', async () => {
    const B = 'B';
    const body = mpAll(B, mpGood(B), `--${B}${C}` + mpPart(`Content-Disposition: form-data; name="n"${C}Content-Transfer-Encoding: base64${C}X-A: EmAiL`, 'ZXZpbEBiYWQuZXhhbXBsZQ=='));
    const w = await runHandler(multipartRequest(body, `multipart/form-data; boundary=${B}`), { status: 'valid' });
    assert.ok(w.text.includes(`name="n"${C}Content-Transfer-Encoding: base64${C}X-A: EmAiL${C}${C}INVALID${C}`));
});

test('R3: more than one "boundary" anywhere in the Content-Type is a 400; a boundary value that holds the word is fine', async () => {
    const body = mpAll('----WebKitFormBoundaryAbc', mpGood('----WebKitFormBoundaryAbc'));
    const ok = await runHandler(multipartRequest(body, 'multipart/form-data; boundary=----WebKitFormBoundaryAbc'), { status: 'invalid' });
    assert.strictEqual(ok.calls.validation.length, 1);
    assert.ok(ok.text.includes('INVALID'));
    const quoted = await runHandler(multipartRequest(body, 'multipart/form-data; boundary="----WebKitFormBoundaryAbc"'), { status: 'invalid' });
    assert.strictEqual(quoted.calls.validation.length, 1);

    for (const type of [
        'multipart/form-data; xboundary=A; boundary=B',
        'multipart/form-data; x="boundary=A"; boundary=B',
        'multipart/form-data; a="x;boundary=A"; boundary=B',
        "multipart/form-data; boundary*=UTF-8''A; boundary=B",
        'multipart/form-data; boundary=----WebKitFormBoundaryAbc; x=boundary',
        'multipart/form-data; boundary=Boundary1; boundary=Boundary1',
    ]) {
        const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
        const response = await worker.context.handleRequest(fetchEvent(multipartRequest(body, type)));
        assert.strictEqual(response.status, 400, type);
        assert.strictEqual(worker.calls.forwarded.length, 0, type);
        assert.strictEqual(worker.calls.validation.length, 0, type);
    }
});

test('R3: boundary="" is not a boundary, and a first line --BBx (the boundary inside the preamble) is a 400', async () => {
    const body = mpAll('B', mpGood('B'));
    for (const type of ['multipart/form-data; boundary=""', 'multipart/form-data; boundary=']) {
        // An empty boundary is refused (400), not forwarded.
        const w = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
        const response = await w.context.handleRequest(fetchEvent(multipartRequest(body, type)));
        assert.strictEqual(response.status, 400, type);
        assert.strictEqual(w.calls.validation.length, 0, type);
        assert.strictEqual(w.calls.forwarded.length, 0, type);
    }
    // "--BBx" is no delimiter line for boundary "BB", but undici reads "--BB" in
    // it as one: the preamble holds the boundary, so the body is refused.
    const text = `--BBx${C}Content-Disposition: form-data; name="email"${C}${C}${EVIL}${C}--BB${C}Content-Disposition: form-data; name="email"${C}${C}${GOOD}${C}--BB--${C}`;
    const w = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    const refused = await w.context.handleRequest(fetchEvent(multipartRequest(text, 'multipart/form-data; boundary=BB')));
    assert.strictEqual(refused.status, 400);
    assert.strictEqual(w.calls.validation.length, 0);
    assert.strictEqual(w.calls.forwarded.length, 0);
});

test('R3: junk after a closing quote in a header parameter does not hide the name', async () => {
    const B = 'B';
    for (const header of ['Content-Disposition: form-data; name="email"junk; x=y', 'Content-Disposition: form-data; name="email"junk', 'Content-Disposition: form-data; name="email" junk']) {
        const body = mpAll(B, `--${B}${C}` + mpPart(header, 'a@x.com'));
        const w = await runHandler(multipartRequest(body, `multipart/form-data; boundary=${B}`), { status: 'invalid' });
        assert.deepStrictEqual(validated(w.calls), ['a@x.com'], header);
        assert.strictEqual(w.text, mpAll(B, `--${B}${C}` + mpPart(header, 'INVALID')), header);
    }
});

test('R3: ip_address comes from CF-Connecting-IP, never from X-Forwarded-For', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    const request = formRequest('email=a%40x.com', { headers: { 'X-Forwarded-For': '203.0.113.99', 'CF-Connecting-IP': '198.51.100.7' } });
    await context.handleRequest(fetchEvent(request));
    assert.strictEqual(calls.validation[0].url.searchParams.get('ip_address'), '198.51.100.7');

    const only = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    const spoof = new Request('https://example.com/f', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '203.0.113.99' }, body: 'email=a%40x.com' });
    await only.context.handleRequest(fetchEvent(spoof));
    assert.strictEqual(only.calls.validation[0].url.searchParams.has('ip_address'), false);
});

test('R3: with no LOGS and no list bindings nothing is reported as an error', async () => {
    const { context, errors, logs } = loadWorker({ API_KEY }, { unbind: ['VALID_STATUS', 'BYPASS_PATH', 'LOGS'] });
    await context.handleRequest(fetchEvent(formRequest('email=a%40x.com')));
    assert.deepStrictEqual(errors, []);
    assert.ok(!logs.some((line) => line.startsWith('Ignoring')));
});

test('R3: a LOGS.put that rejects is logged as a redacted error and does not stop the request', async () => {
    const LOGS = { put: async () => { throw new Error(`KV down ${API_KEY}`); } };
    const { context, calls, errors } = loadWorker({ API_KEY, VALID_STATUS: ['valid'], LOGS });
    const { event, waits } = waitingEvent(formRequest('email=a%40x.com'));
    await context.handleRequest(event);
    assert.strictEqual(waits.length, 1);
    await Promise.all(waits);
    assert.strictEqual(calls.forwarded.length, 1);
    assert.ok(errors.some((line) => line.includes('Unable to write the validation log to KV')));
    for (const line of errors) assert.ok(!line.includes(API_KEY), line);
});

test('R3: the Content-Type is logged as its media type only, cut at 100 characters, and a huge one is cheap', async () => {
    const huge = `multipart/form-data; boundary=B; x=${'a'.repeat(65000)}`;
    const { context, logs } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    const start = Date.now();
    await context.handleRequest(fetchEvent(multipartRequest(mpAll('B', mpGood('B')), huge)));
    assert.ok(Date.now() - start < 2000);
    const line = logs.find((l) => l.startsWith('Incoming content type'));
    assert.strictEqual(line, 'Incoming content type: multipart/form-data');
    assert.ok(!logs.some((l) => l.includes('aaaaaaaa')));

    const long = await loadWorker({ API_KEY });
    await long.context.handleRequest(fetchEvent(new Request('https://example.com/f', { method: 'POST', headers: { 'content-type': `text/${'z'.repeat(300)}` }, body: 'x' })));
    const cut = long.logs.find((l) => l.startsWith('Incoming content type'));
    assert.strictEqual(cut.length, 'Incoming content type: '.length + 100);
});

test('R3: truncateUtf8 keeps exactly 512 bytes and never splits a code point', () => {
    const { context } = loadWorker({ API_KEY });
    assert.strictEqual(context.truncateUtf8('a'.repeat(512), 512).length, 512);
    assert.strictEqual(context.truncateUtf8('a'.repeat(513), 512).length, 512);
    assert.strictEqual(context.truncateUtf8('é'.repeat(256), 512), 'é'.repeat(256));
    assert.strictEqual(context.truncateUtf8('é'.repeat(257), 512), 'é'.repeat(256));
    assert.strictEqual(context.truncateUtf8('a'.repeat(511) + 'é', 512), 'a'.repeat(511));
    assert.strictEqual(context.truncateUtf8('a'.repeat(509) + '\u{1F600}', 512), 'a'.repeat(509));
    assert.strictEqual(context.truncateUtf8('a'.repeat(508) + '\u{1F600}', 512), 'a'.repeat(508) + '\u{1F600}');
});

// ---------------------------------------------------------------------------
// Round 4: email-field values that are not plain addresses, Content-Type and
// boundary handling, RFC 2231 names
// ---------------------------------------------------------------------------

async function assertRefused400(request, label = '') {
    const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    const response = await worker.context.handleRequest(fetchEvent(request));
    assert.strictEqual(response.status, 400, label);
    assert.strictEqual(worker.calls.forwarded.length, 0, label);
    assert.strictEqual(worker.calls.validation.length, 0, label);
}

async function refusedWith400(type, body = 'email=a%40x.com') {
    const w = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    const response = await w.context.handleRequest(fetchEvent(multipartRequest(body, type)));
    return { status: response.status, w };
}

const NOT_PLAIN = [
    '"bad"@y.com',
    '<a@b>',
    'Name <a@b>',
    'a@b,c@d',
    'a@b.com\u0000',
    'a@b.com​',
    'a@bücher.de',
    'ünï@b.com',
    'a@b.com ',
];

test('R4-1: url-encoded email fields that hold "@" without being a plain address become INVALID and are never sent to the API', async () => {
    for (const bad of NOT_PLAIN) {
        const enc = encodeURIComponent(bad);
        const { calls, text } = await runHandler(formRequest(`email=good%40ok.example&your-email=${enc}`), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['good@ok.example'], bad);
        assert.strictEqual(text, 'email=good%40ok.example&your-email=INVALID', bad);
        // Raw "%40" in a field whose decoded value is not an address, and the chosen field first or last.
        const other = await runHandler(formRequest(`contact_email=${enc}&email=good%40ok.example`), { status: 'invalid' });
        assert.deepStrictEqual(validated(other.calls), ['good@ok.example'], bad);
        assert.strictEqual(other.text, 'contact_email=INVALID&email=INVALID', bad);
    }
});

test('R4-1: with no address among the email fields, an email field holding "@" is rewritten and nothing is validated', async () => {
    for (const bad of NOT_PLAIN) {
        const { calls, text } = await runHandler(formRequest(`name=x&email=${encodeURIComponent(bad)}`), { status: 'valid' });
        assert.strictEqual(calls.validation.length, 0, bad);
        assert.strictEqual(text, 'name=x&email=INVALID', bad);
    }
    // Rewriting needs no API call, so it also happens with no API_KEY.
    const w = loadWorker({ VALID_STATUS: ['valid'] });
    await w.context.handleRequest(fetchEvent(formRequest('email=Name%20%3Ca%40b%3E')));
    assert.strictEqual(w.calls.validation.length, 0);
    assert.strictEqual(await w.calls.forwarded[0].text(), 'email=INVALID');
    // Without VALID_STATUS nothing is rewritten; a value with no "@" stays.
    const open = await runHandler(formRequest('email=%3Ca%40b%3E'), { status: 'valid', bindings: { VALID_STATUS: undefined } });
    assert.strictEqual(open.text, 'email=%3Ca%40b%3E');
    const plain = await runHandler(formRequest('email=hello'), { status: 'valid' });
    assert.strictEqual(plain.text, 'email=hello');
});

test('R4-1: the fallback leaves non-email fields alone, but still rewrites email fields that hold "@"', async () => {
    const { calls, text } = await runHandler(formRequest('note=Name%20%3Ca%40b%3E&contact=good%40ok.example&e_mail_email=a%40b%2Cc%40d'), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['good@ok.example']);
    assert.strictEqual(text, 'note=Name%20%3Ca%40b%3E&contact=good%40ok.example&e_mail_email=INVALID');
});

test('R4-1: the same address with another case or surrounding space is kept; a different one is not', async () => {
    const { calls, text } = await runHandler(formRequest('email=Good%40OK.example&your-email=%20good%40ok.EXAMPLE%20&e2_email=other%40ok.example'), { status: 'valid' });
    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(text, 'email=Good%40OK.example&your-email=%20good%40ok.EXAMPLE%20&e2_email=INVALID');
});

test('R4-1: sameAddress folds ASCII case only and trims ASCII white space only', async () => {
    const { context } = loadWorker({ API_KEY });
    assert.strictEqual(context.sameAddress(' A@X.com\t', 'a@x.COM'), true);
    assert.strictEqual(context.sameAddress('K@x.com', 'K@x.com'), false);
    assert.strictEqual(context.sameAddress('a@x.com ', 'a@x.com'), false);
    assert.strictEqual(context.isAddress('a@x.com '), false);
    assert.strictEqual(context.isAddress('\n a@x.com \t'), true);
});

test('R4-1: formFields marks a value sent with %40 as holding an "@"', async () => {
    const { context } = loadWorker({ API_KEY });
    const fields = context.formFields(new TextEncoder().encode('a=x%40y&b=x@y&c=xy'));
    assert.deepStrictEqual([fields[0].at, fields[1].at, fields[2].at], [true, false, false]);
});

test('R4-1: multipart parts and JSON keys follow the same rule', async () => {
    for (const bad of NOT_PLAIN) {
        const body = mpBody(field('email', 'good@ok.example'), field('your-email', bad), field('note', bad));
        const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['good@ok.example'], bad);
        assert.strictEqual(text, mpBody(field('email', 'good@ok.example'), field('your-email', 'INVALID'), field('note', bad)), bad);

        const alone = await runHandler(mpRequest(mpBody(field('email', bad))), { status: 'valid' });
        assert.strictEqual(alone.calls.validation.length, 0, bad);
        assert.strictEqual(alone.text, mpBody(field('email', 'INVALID')), bad);

        const json = await runHandler(jsonRequest({ email: 'good@ok.example', your_email: bad, note: bad }), { status: 'valid' });
        assert.deepStrictEqual(validated(json.calls), ['good@ok.example'], bad);
        assert.deepStrictEqual(JSON.parse(JSON.parse(json.text).form), { email: 'good@ok.example', your_email: 'INVALID', note: bad }, bad);

        const only = await runHandler(jsonRequest({ email: bad }), { status: 'valid' });
        assert.strictEqual(only.calls.validation.length, 0, bad);
        assert.deepStrictEqual(JSON.parse(JSON.parse(only.text).form), { email: 'INVALID' }, bad);
    }
});

test('R4-1: a rejected address rewrites every email field that holds "@"', async () => {
    const { calls, text } = await runHandler(formRequest('email=bad%40x.com&b_email=%3Cq%40r%3E&c_email=hello'), { status: 'invalid' });
    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(text, 'email=INVALID&b_email=INVALID&c_email=hello');
});

// Rule 2: Content-Type classification

test('R4-2: an ambiguous Content-Type is answered 400, with no API or origin call', async () => {
    const types = [
        'multipart/form-data, x',
        'multipart/form-data x',
        'x multipart/form-data',
        'text/plain, multipart/form-data',
        'multipart/form-data, application/x-www-form-urlencoded',
        'application/x-www-form-urlencoded, multipart/form-data; boundary=zb-b',
        'multipart/form-data; boundary=zb-b; x=application/x-www-form-urlencoded',
        'application/x-www-form-urlencoded; boundary=zb-b; x=multipart/form-data',
        'application/x-www-form-urlencoded, text/plain',
        'text/plain application/x-www-form-urlencoded',
        'text/plain; note="application/x-www-form-urlencoded"',
        'TEXT/PLAIN, MULTIPART/FORM-DATA',
    ];
    for (const type of types) {
        const w = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
        // A body that is well formed for the type (multipart for zb-b, else
        // url-encoded), so only the Content-Type guard can produce the 400.
        const body = type.includes('boundary=zb-b') ? mpBody(field('email', 'a@x.com')) : 'email=a%40x.com';
        const response = await w.context.handleRequest(fetchEvent(multipartRequest(body, type)));
        assert.strictEqual(response.status, 400, type);
        assert.strictEqual(await response.text(), 'Bad Request');
        assert.strictEqual(w.calls.validation.length, 0, type);
        assert.strictEqual(w.calls.forwarded.length, 0, type);
    }
});

test('R4-2: normal Content-Type values keep working in any case and with spaces', async () => {
    const urlencoded = ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded;charset=UTF-8', 'Application/X-WWW-Form-URLEncoded; charset=utf-8', 'APPLICATION/X-WWW-FORM-URLENCODED', 'application/x-www-form-urlencoded ; charset=UTF-8', ' application/x-www-form-urlencoded; charset="UTF-8" '];
    for (const type of urlencoded) {
        const { calls, text } = await runHandler(formRequest('email=bad%40x.com&n=1', { headers: { 'content-type': type } }), { status: 'invalid' });
        assert.strictEqual(calls.validation.length, 1, type);
        assert.strictEqual(text, 'email=INVALID&n=1', type);
    }
    const multipart = ['multipart/form-data; boundary=zb-b', 'Multipart/Form-Data;boundary=zb-b', 'MULTIPART/FORM-DATA ; BOUNDARY=zb-b', ' multipart/form-data;  boundary="zb-b" ; charset=utf-8'];
    for (const type of multipart) {
        const body = mpBody(field('email', 'bad@x.com'));
        const { calls, text } = await runHandler(multipartRequest(body, type), { status: 'invalid' });
        assert.strictEqual(calls.validation.length, 1, type);
        assert.strictEqual(text, mpBody(field('email', 'INVALID')), type);
    }
    // Other media types (JSON branch and the rest) are as before.
    const json = await runHandler(jsonRequest({ email: 'bad@x.com' }), { status: 'invalid' });
    assert.deepStrictEqual(JSON.parse(JSON.parse(json.text).form), { email: 'INVALID' });
    const plain = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
    const response = await plain.context.handleRequest(fetchEvent(multipartRequest('email=a%40x.com', 'text/plain')));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(plain.calls.validation.length, 0);
});

// Rule 3: the boundary value

test('R4-3: an empty, too long or non-bchar boundary is answered 400', async () => {
    const bad = [
        'boundary=',
        'boundary=""',
        `boundary=${'a'.repeat(71)}`,
        `boundary="${'a'.repeat(71)}"`,
        'boundary="ab "',
        'boundary="a\\\\b"',
        'boundary="a\\"b"',
        'boundary="a;b"',
        'boundary="aéb"',
        'boundary="a<b"',
        'boundary=a"b',
        'boundary=a@b',
        'boundary=a,b',
        'boundary=ab,',
        'boundary=a\u0001b',
    ];
    for (const parameter of bad) {
        const type = `multipart/form-data; ${parameter}`;
        // The body is well formed for the boundary as written (quotes and
        // backslash escapes undone), so only the boundary guard can refuse it.
        const written = parameter.slice('boundary='.length).replace(/^"(.*)"$/s, '$1').replace(/\\(.)/g, '$1');
        const { status, w } = await refusedWith400(type, rawMp(written, field('email', 'a@x.com')));
        assert.strictEqual(status, 400, type);
        assert.strictEqual(w.calls.validation.length, 0, type);
        assert.strictEqual(w.calls.forwarded.length, 0, type);
    }
});

test('R4-3: boundaries RFC 2046 allows are read', async () => {
    const good = [
        'zb-b',
        'a'.repeat(70),
        "'()+_-./:=?0aZ",
        'a b',
        // A comma is a bchar; quoted, parsers read it as part of the boundary.
    ];
    for (const boundary of good) {
        for (const parameter of [`boundary="${boundary}"`, ...(boundary.includes(' ') ? [] : [`boundary=${boundary}`])]) {
            const type = `multipart/form-data; ${parameter}`;
            const body = rawMp(boundary, field('email', 'bad@x.com'));
            const { calls, text } = await runHandler(multipartRequest(body, type), { status: 'invalid' });
            assert.strictEqual(calls.validation.length, 1, type);
            assert.strictEqual(text, rawMp(boundary, field('email', 'INVALID')), type);
        }
    }
    const quotedComma = await runHandler(multipartRequest(rawMp('a,b', field('email', 'bad@x.com')), 'multipart/form-data; boundary="a,b"'), { status: 'invalid' });
    assert.strictEqual(quotedComma.calls.validation.length, 1);
});

test('R4-3: an unquoted boundary is trimmed (boundary=XX with trailing blanks still works)', async () => {
    const { context } = loadWorker({ API_KEY });
    for (const type of ['multipart/form-data; boundary=XX ', 'multipart/form-data; boundary= XX', 'multipart/form-data; boundary=\tXX \t; charset=utf-8', 'multipart/form-data; boundary=XX ; charset=utf-8']) {
        const parsed = context.multipartBoundary(type);
        assert.strictEqual(parsed.boundary, 'XX', type);
        assert.strictEqual(parsed.ambiguous, false, type);
    }
    // end to end, with a space before the next parameter
    const { calls, text } = await runHandler(multipartRequest(rawMp('XX', field('email', 'bad@x.com')), 'multipart/form-data; boundary=XX ; charset=utf-8'), { status: 'invalid' });
    assert.strictEqual(calls.validation.length, 1);
    assert.strictEqual(text, rawMp('XX', field('email', 'INVALID')));
});

test('R4-3: the backslash exception for a boundary that holds the word "boundary" is gone: a backslash boundary is refused anyway', async () => {
    const { context } = loadWorker({ API_KEY });
    for (const type of ['multipart/form-data; boundary="x\\\\boundary"', 'multipart/form-data; boundary="a\\\\b"; x=boundary']) {
        assert.strictEqual(context.multipartBoundary(type).ambiguous, true, type);
        assert.strictEqual(context.multipartBoundary(type).boundary, null, type);
    }
    // A boundary that holds the word itself is still the chosen one.
    assert.strictEqual(context.multipartBoundary('multipart/form-data; boundary=----WebKitFormBoundaryAbC').ambiguous, false);
});

test('R4-3: real browser posts keep working (Chrome/Safari WebKit, Firefox old and gecko, plain url-encoded with charset)', async () => {
    const boundaries = [
        '----WebKitFormBoundary7MA4YWxkTrZu0gW',
        '----WebKitFormBoundaryAbCdEfGhIjKlMnOp',
        '---------------------------1234567890123',
        '---------------------------12345678901234567890',
        '---------------------------1234',
        '----geckoformboundary0123456789abcdef0123456789abcdef',
        '----geckoformboundaryd7ec4d2a8c3f4b7d9e1a2b3c4d5e6f70',
    ];
    for (const boundary of boundaries) {
        for (const type of [`multipart/form-data; boundary=${boundary}`, `multipart/form-data; boundary="${boundary}"`]) {
            const body = [
                `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nAnna\r\n`,
                `--${boundary}\r\nContent-Disposition: form-data; name="email"\r\n\r\nbad@x.com\r\n`,
                `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nPNG\r\n`,
                `--${boundary}--\r\n`,
            ].join('');
            const { calls, text } = await runHandler(multipartRequest(body, type), { status: 'invalid' });
            assert.deepStrictEqual(validated(calls), ['bad@x.com'], type);
            assert.strictEqual(text, body.replace('bad@x.com', 'INVALID'), type);
        }
    }
    const form = await runHandler(formRequest('name=Anna&email=bad%40x.com', { headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' } }), { status: 'invalid' });
    assert.strictEqual(form.text, 'name=Anna&email=INVALID');
});

// Rule 4: RFC 2231 names

test('R4-4: a part named with name*= (percent-encoded) is an email field', async () => {
    const encoded = [
        "name*=UTF-8''%65mail",
        "NAME*=utf-8''%45MAIL",
        "name*=UTF-8'en'%65mail",
        "name*0*=UTF-8''%65ma; name*1*=il",
        "x=1; name*=UTF-8''your-%65mail",
    ];
    for (const header of encoded) {
        const part = `Content-Disposition: form-data; ${header}\r\n\r\nother@bad.example`;
        const body = rawMp('zb-b', field('email', 'good@ok.example'), part);
        const { calls, text } = await runHandler(mpRequest(body), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['good@ok.example'], header);
        assert.strictEqual(text, rawMp('zb-b', field('email', 'good@ok.example'), part.replace('other@bad.example', 'INVALID')), header);
    }
    // On its own it is the validated field.
    const part = "Content-Disposition: form-data; name*=UTF-8''%65mail\r\n\r\nbad@x.com";
    const { calls, text } = await runHandler(mpRequest(rawMp('zb-b', part)), { status: 'invalid' });
    assert.deepStrictEqual(validated(calls), ['bad@x.com']);
    assert.strictEqual(text, rawMp('zb-b', part.replace('bad@x.com', 'INVALID')));
    // An encoded name that is not an email name, and a file part with an encoded email name.
    const other = "Content-Disposition: form-data; name*=UTF-8''%6eote\r\n\r\nx@y.example";
    const plain = await runHandler(mpRequest(rawMp('zb-b', other)), { status: 'valid' });
    assert.strictEqual(plain.text, rawMp('zb-b', other));
});

// Rule 5: gaps

test('R4-5: header parameter parsing details', async () => {
    const { context } = loadWorker({ API_KEY });
    const list = (text) => JSON.parse(JSON.stringify(context.headerParameterList(text)));
    // A backslash escape inside a quoted value is unescaped.
    assert.strictEqual(context.headerParameters('x; a="b\\"c\\\\d"').a, 'b"c\\d');
    // Junk after a closing quote is skipped to the next ";".
    assert.deepStrictEqual(list('x; a="v"junk; b=2').map(([n, v]) => [n, v]), [['a', 'v'], ['b', '2']]);
    // The first of a repeated parameter wins.
    assert.strictEqual(context.headerParameters('x; a=1; a=2').a, '1');
    assert.strictEqual(context.headerParameters('x; a=1; A=2').a, '1');
    // A parameter with no name is dropped.
    assert.deepStrictEqual(list('x; =v; a=1; ="q"').map(([n, v]) => [n, v]), [['a', '1']]);
    // The quoted flag.
    assert.deepStrictEqual(list('x; a="1"; b=2').map(([, , q]) => q), [true, false]);
});

test('R4-5: folded Content-Disposition lines are joined', async () => {
    const part = 'Content-Disposition: form-data;\r\n name="email"\r\n\r\nbad@x.com';
    const { calls, text } = await runHandler(mpRequest(rawMp('zb-b', part)), { status: 'invalid' });
    assert.deepStrictEqual(validated(calls), ['bad@x.com']);
    assert.strictEqual(text, rawMp('zb-b', part.replace('bad@x.com', 'INVALID')));
    // The joined header gives the exact name "email", which is chosen ahead of an earlier x_email field.
    const folded = rawMp('zb-b', field('x_email', 'first@x.com'), 'Content-Disposition: form-data;\r\n name="email"\r\n\r\nsecond@x.com');
    const f = await runHandler(mpRequest(folded), { status: 'valid' });
    assert.deepStrictEqual(validated(f.calls), ['second@x.com']);
    const tabbed = 'Content-Disposition: form-data;\r\n\tname="email"\r\n\r\nbad@x.com';
    const t = await runHandler(mpRequest(rawMp('zb-b', tabbed)), { status: 'invalid' });
    assert.deepStrictEqual(validated(t.calls), ['bad@x.com']);
});

test('R4-5: repeated Content-Disposition headers make the body malformed', async () => {
    const { context } = loadWorker({ API_KEY });
    const bytes = new TextEncoder().encode(rawMp('B', 'Content-Disposition: form-data; name="x_email"\r\nContent-Disposition: form-data; name="email"\r\n\r\nv@x.com'));
    assert.match(context.multipartFields(bytes, 'B').malformed, /more than one Content-Disposition/);
});

test('R4-5: the fallback rewrites repeats of the chosen name that are not empty, and only those', async () => {
    const { calls, text } = await runHandler(formRequest('contact=good%40ok.example&contact=&contact=x&other=y'), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['good@ok.example']);
    assert.strictEqual(text, 'contact=good%40ok.example&contact=&contact=INVALID&other=y');
    const rejected = await runHandler(formRequest('contact=bad%40x.com&contact=%20&contact=x'), { status: 'invalid' });
    assert.strictEqual(rejected.text, 'contact=INVALID&contact=%20&contact=INVALID');
});

test('R4-5: list bindings: U+201A, guillemet-like quotes, JSON arrays with a non-string, a separator item and a null binding', async () => {
    const { context } = loadWorker({ API_KEY });
    const entries = (value) => JSON.parse(JSON.stringify(context.listEntries(value)));
    assert.deepStrictEqual(entries('‚valid‚, ‹catch-all›'), ['valid', 'catch-all']);
    assert.deepStrictEqual(entries('‚valid‛|›unknown‹'), ['valid', 'unknown']);
    // A JSON array with a non-string item is not a JSON list: it is read as text.
    assert.deepStrictEqual(entries('["valid",1]'), ['valid', '1']);
    assert.deepStrictEqual(entries('["valid",null]'), ['valid', 'null']);
    // A JSON array item holding a separator inside is one entry, whole.
    assert.deepStrictEqual(entries('["/a b"]'), ['/a b']);
    assert.deepStrictEqual(entries('[" /a b, "]'), ['/a b']);
    assert.deepStrictEqual(entries(['/a b', ' valid ,']), ['/a b', 'valid']);
    assert.strictEqual(context.listEntries(5), null);
    assert.strictEqual(context.listEntries(['valid', 1]), null);
    // bindingList: unset and null are no list, and no log line.
    const w = loadWorker({ API_KEY });
    assert.strictEqual(w.context.bindingList('BYPASS_PATH', null), null);
    assert.strictEqual(w.context.bindingList('BYPASS_PATH', undefined), null);
    assert.deepStrictEqual(w.logs.filter((l) => l.startsWith('Ignoring')), []);
    // e2e: a bypass path with a separator in it, typed as a JSON array item, is one entry
    const bypass = await runHandler(formRequest('email=bad%40x.com', { url: 'https://example.com/a,b' }), { bindings: { BYPASS_PATH: '["/a,b"]' }, status: 'invalid' });
    assert.strictEqual(bypass.text, 'email=bad%40x.com');
    assert.strictEqual(bypass.calls.validation.length, 0);
});

// ---------------------------------------------------------------------------
// Round 5
// ---------------------------------------------------------------------------

test('round 5: file parts reach the origin byte for byte, whatever their headers or filenames say', async () => {
    const enc = new TextEncoder();
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x40, 0x40, 0x00, 0xff, 0x40]);
    const parts = [
        ['Content-Disposition: form-data; name="doc"; filename="my-email.eml"\r\nContent-Type: message/rfc822\r\n\r\n', enc.encode('From: someone@bad.example\r\n\r\nhi')],
        ['Content-Disposition: form-data; name="email_list"; filename="list.csv"\r\nContent-Type: text/csv\r\n\r\n', enc.encode('a@bad.example,b@bad.example\n')],
        ['Content-Disposition: form-data; name="email"; filename=""\r\n\r\n', enc.encode('c@bad.example')],
        ['Content-Disposition: form-data; name="x"; filename="email.txt"\r\n\r\n', enc.encode('d@bad.example')],
        ['Content-Disposition: form-data; name="img"; filename="e.png"\r\nContent-Type: image/png\r\nX-Note: email\r\n\r\n', png],
    ];
    const chunks = [enc.encode('--zb-b\r\nContent-Disposition: form-data; name="email"\r\n\r\ng@ok.example\r\n')];
    for (const [head, content] of parts) {
        chunks.push(enc.encode('--zb-b\r\n'), enc.encode(head), content, enc.encode('\r\n'));
    }
    chunks.push(enc.encode('--zb-b--\r\n'));
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.length; }

    for (const status of ['valid', 'invalid']) {
        const { calls, body } = await runHandler(mpRequest(all), { status });
        assert.deepStrictEqual(validated(calls), ['g@ok.example']);
        const expected = status === 'valid' ? all : new TextEncoder().encode(new TextDecoder('latin1').decode(all).replace('g@ok.example', 'INVALID'));
        if (status === 'valid') {
            assert.deepStrictEqual(Buffer.from(body), Buffer.from(expected));
        } else {
            // Only the email value changed: every other byte, file bytes included, is the same.
            const before = Buffer.from(all);
            const after = Buffer.from(body);
            const marker = Buffer.from('g@ok.example');
            const index = before.indexOf(marker);
            assert.deepStrictEqual(after, Buffer.concat([before.subarray(0, index), Buffer.from('INVALID'), before.subarray(index + marker.length)]));
        }
    }
});

test('round 5: forwardWithBody does not carry the incoming Content-Length', async () => {
    const stale = new Request('https://example.com/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '999', 'CF-Connecting-IP': '198.51.100.7' },
        body: 'email=bad%40x.com',
    });
    assert.strictEqual(stale.headers.get('content-length'), '999');
    const { calls, text } = await runHandler(stale, { status: 'invalid' });
    assert.strictEqual(text, 'email=INVALID');
    assert.strictEqual(calls.forwarded[0].headers.get('content-length'), null);
    // The other headers stay.
    assert.strictEqual(calls.forwarded[0].headers.get('content-type'), 'application/x-www-form-urlencoded');
    assert.strictEqual(calls.forwarded[0].headers.get('CF-Connecting-IP'), '198.51.100.7');
    // The multipart and JSON paths too.
    const mp = new Request('https://example.com/upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${MP}`, 'content-length': '5' },
        body: mpBody(field('email', 'bad@x.com')),
    });
    assert.strictEqual((await runHandler(mp, { status: 'invalid' })).calls.forwarded[0].headers.get('content-length'), null);
});

test('round 5: list entries are trimmed in linear time', async () => {
    const { context } = loadWorker({ API_KEY });
    for (const filler of [' ', ',', ';', '|', '\t', ', ']) {
        const run = filler.repeat(Math.ceil(200000 / filler.length));
        const started = Date.now();
        assert.deepStrictEqual(JSON.parse(JSON.stringify(context.listEntries([`${run}a${run}b${run}`]))), [`a${run}b`]);
        context.listEntries(`${run}x`);
        assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms for ${JSON.stringify(filler)}`);
    }
    assert.deepStrictEqual(JSON.parse(JSON.stringify(context.listEntries([' ,;| a b ;,| ', ',', '  ']))), ['a b']);
});

test('round 5 E7: a 2xx result with a non-string error member fails open', async () => {
    const answer = async (extra) => {
        const { context } = loadWorker({ API_KEY });
        context.fetch = async () => new Response(JSON.stringify({ status: 'invalid', address: 'a@x.com', ...extra }), { status: 200, headers: { 'content-type': 'application/json' } });
        return context.validateEmail('a@x.com', null);
    };
    for (const key of ['error', 'error_message', 'Error']) {
        for (const value of [5, -1, 0.5, true, { code: 1 }, ['x'], 'text']) {
            const result = await answer({ [key]: value });
            assert.strictEqual(typeof result, 'string', `${key}=${JSON.stringify(value)}`);
        }
        // Empty values are no error.
        for (const value of [0, false, null, '', '  ', [], {}]) {
            const result = await answer({ [key]: value });
            assert.strictEqual(typeof result, 'object', `${key}=${JSON.stringify(value)}`);
        }
    }
    // End to end: the address is not rewritten.
    for (const value of [5, true]) {
        const worker = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { status: 'invalid', address: 'bad@x.com', error: value } });
        await worker.context.handleRequest(fetchEvent(formRequest('email=bad%40x.com')));
        assert.strictEqual(worker.calls.validation.length, 1);
        assert.strictEqual(new TextDecoder().decode(new Uint8Array(await worker.calls.forwarded[0].arrayBuffer())), 'email=bad%40x.com');
    }
});

test('round 5: a raw field name that merely contains email counts as an email field', async () => {
    // "%1email" does not percent-decode ("%1e" is no escape); the name still holds email.
    const url = await runHandler(formRequest('%1email=e%40bad.example&email=g%40ok.example'), { status: 'valid' });
    assert.deepStrictEqual(validated(url.calls), ['g@ok.example']);
    assert.strictEqual(url.text, '%1email=INVALID&email=g%40ok.example');
    const mp = await runHandler(mpRequest(mpBody(field('email', 'g@ok.example'), field('%1email', 'e@bad.example'))), { status: 'valid' });
    assert.deepStrictEqual(validated(mp.calls), ['g@ok.example']);
    assert.strictEqual(mp.text, mpBody(field('email', 'g@ok.example'), field('%1email', 'INVALID')));
    // An encoded name that decodes to email.
    const enc = await runHandler(formRequest('email=g%40ok.example&%65mail=e%40bad.example'), { status: 'valid' });
    assert.strictEqual(enc.text, 'email=g%40ok.example&%65mail=INVALID');
});

test('round 5: an exact RFC 2231 name is preferred over an earlier email-like name', async () => {
    const first = field('x_email', 'first@x.com');
    const star = "Content-Disposition: form-data; name*=UTF-8''email\r\n\r\nsecond@x.com";
    const { calls } = await runHandler(mpRequest(mpBody(first, star)), { status: 'valid' });
    assert.deepStrictEqual(validated(calls), ['second@x.com']);
    const encoded = "Content-Disposition: form-data; name*=UTF-8''%65mail\r\n\r\nthird@x.com";
    const e = await runHandler(mpRequest(mpBody(first, encoded)), { status: 'valid' });
    assert.deepStrictEqual(validated(e.calls), ['third@x.com']);
    // Same text without the star: a plain name field is the exact one.
    const plain = await runHandler(mpRequest(mpBody(first, field('email', 'second@x.com'))), { status: 'valid' });
    assert.deepStrictEqual(validated(plain.calls), ['second@x.com']);
});

test('round 5: an address of 255 to 320 characters is accepted, one of 321 is not', async () => {
    const make = (length) => `${'a'.repeat(length - '@x.com'.length)}@x.com`;
    for (const length of [254, 255, 300, 320]) {
        const address = make(length);
        assert.strictEqual(address.length, length);
        const { calls } = await runHandler(formRequest(`email=${encodeURIComponent(address)}`), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), [address], String(length));
    }
    const long = make(321);
    const refused = await runHandler(formRequest(`email=${encodeURIComponent(long)}`), { status: 'valid' });
    assert.strictEqual(refused.calls.validation.length, 0);
    const { context } = loadWorker({ API_KEY });
    assert.strictEqual(context.isAddress(make(320)), true);
    assert.strictEqual(context.isAddress(make(321)), false);
});

test('round 5: a trailing %0D, %0A, %20 or + in a url-encoded value is trimmed before validation', async () => {
    for (const tail of ['%0D', '%0A', '%0D%0A', '%20', '+', '%09']) {
        const { calls, text } = await runHandler(formRequest(`email=g%40ok.example${tail}&n=1`), { status: 'valid' });
        assert.deepStrictEqual(validated(calls), ['g@ok.example'], tail);
        assert.strictEqual(text, `email=g%40ok.example${tail}&n=1`, tail);
    }
    const lead = await runHandler(formRequest('email=%0D%0Ag%40ok.example'), { status: 'valid' });
    assert.deepStrictEqual(validated(lead.calls), ['g@ok.example']);
});

test('round 5: apiErrorText skips whitespace-only text under every key', async () => {
    const { context } = loadWorker({ API_KEY });
    const fallback = 'ZeroBounce returned no validation status.';
    for (const key of ['error', 'error_message', 'Error', 'message', 'Message', 'detail']) {
        assert.strictEqual(context.apiErrorText({ [key]: ' \t\r\n ' }), fallback, key);
        assert.strictEqual(context.apiErrorText({ [key]: '' }), fallback, key);
        assert.strictEqual(context.apiErrorText({ [key]: '  text  ' }), 'text', key);
        // A whitespace-only value does not stop the search for the next key.
        assert.strictEqual(context.apiErrorText({ [key]: ' ', ...(key === 'detail' ? { message: 'later' } : { detail: 'later' }) }), 'later', key);
    }
    assert.strictEqual(context.apiErrorText({ message: ' ' }, 'custom'), 'custom');
});


// ---------------------------------------------------------------------------
// Fix round 6: preamble, KV member names, non-UTF-8 answer
// ---------------------------------------------------------------------------

const PRE_EMAIL = 'Content-Disposition: form-data; name="email"\r\n\r\nevil@bad.example\r\n';
const PRE_GOOD = '--B\r\nContent-Disposition: form-data; name="email"\r\n\r\ngood@ok.example\r\n--B--\r\n';

test('R6: a preamble that holds the boundary anywhere is answered 400, with no API or origin call', async () => {
    const bodies = {
        'x--B': `x--B\r\n${PRE_EMAIL}${PRE_GOOD}`,
        'space --B': ` --B\r\n${PRE_EMAIL}${PRE_GOOD}`,
        'CR --B': `\r--B\r\n${PRE_EMAIL}${PRE_GOOD}`,
        '--B--B': `--B--B\r\n${PRE_EMAIL}${PRE_GOOD}`,
        '--B x': `--B x\r\n${PRE_EMAIL}${PRE_GOOD}`,
        'preamble-only email part': `x--B\r\n${PRE_EMAIL}--B--\r\n`,
        'no delimiter line at all': `--B\r${PRE_EMAIL}`,
        'boundary on a later preamble line': `ok\r\nx--B\r\n${PRE_EMAIL}${PRE_GOOD}`,
        'boundary on a later LF preamble line': `line one\nline two x--B\n${PRE_EMAIL}${PRE_GOOD}`,
    };
    for (const [name, body] of Object.entries(bodies)) {
        const w = loadWorker({ API_KEY, VALID_STATUS: ['valid'] });
        const response = await w.context.handleRequest(fetchEvent(multipartRequest(body, 'multipart/form-data; boundary=B')));
        assert.strictEqual(response.status, 400, name);
        assert.strictEqual(w.calls.validation.length, 0, name);
        assert.strictEqual(w.calls.forwarded.length, 0, name);
    }
});

test('R6: a KV record whose member name holds an encoded key is still stored as JSON', async () => {
    const key = 'zb-dummy-key-0001';
    for (const name of [key.replace('0001', '%30001'), key.replace('0001', '&#48;001'), key.toUpperCase()]) {
        const stored = [];
        const w = loadWorker({ API_KEY: key, VALID_STATUS: ['valid'], LOGS: { put: (k, v) => { stored.push(v); return Promise.resolve(); } } },
            { validationResponse: { address: 'a@b.co', status: 'valid', [name]: 1 } });
        await w.context.handleRequest(fetchEvent(formRequest('email=a%40b.co')));
        assert.strictEqual(stored.length, 1, name);
        const value = JSON.parse(stored[0]);
        assert.ok(value && typeof value === 'object', name);
        assert.ok(!stored[0].toLowerCase().includes('0001') || !stored[0].toLowerCase().includes('dummy-key'), name);
    }
});

test('R6: a plain-text preamble (even one mentioning dashes) is still validated and the part rewritten', async () => {
    for (const preamble of ['This is a MIME message\r\n', 'a -B b\r\n', '-- B\r\n', '']) {
        const body = `${preamble}${PRE_GOOD}`;
        const { calls, text } = await runHandler(multipartRequest(body, 'multipart/form-data; boundary=B'), { status: 'invalid' });
        assert.strictEqual(calls.validation.length, 1, JSON.stringify(preamble));
        assert.strictEqual(text, body.replace('good@ok.example', 'INVALID'), JSON.stringify(preamble));
    }
});

test('R6: the preamble check is linear (1 MiB of dashes and CR before the first delimiter)', async () => {
    for (const filler of ['-', '\r', '-\n', '--A']) {
        const body = `${filler.repeat(Math.ceil(1048576 / filler.length))}\r\n${PRE_GOOD}`;
        const started = Date.now();
        await runHandler(multipartRequest(body, 'multipart/form-data; boundary=B'), { status: 'invalid' }).catch(() => {});
        assert.ok(Date.now() - started < 3000, JSON.stringify(filler));
    }
});

test('R6: the key never reaches KV as a member name, nested, URL-encoded or \\u-escaped', async () => {
    const K = 'zb-dummy-key-0001';
    const bodies = {
        member: { address: 'a@b.co', status: 'valid', [K]: 1 },
        nested: { address: 'a@b.co', status: 'valid', x: { ['pre' + K]: {} } },
        encoded: { address: 'a@b.co', status: 'valid', [encodeURIComponent(K)]: 1 },
        escaped: '{"address":"a@b.co","status":"valid","zb-dummy-key-\\u0030001":1}',
        value: { address: 'a@b.co', status: 'valid', sub_status: K },
    };
    for (const [name, answer] of Object.entries(bodies)) {
        const kv = recordingKv();
        const w = loadWorker({ API_KEY: K, VALID_STATUS: ['valid'], LOGS: kv.LOGS }, {
            validationResponse: typeof answer === 'string' ? new TextEncoder().encode(answer) : answer,
        });
        await w.context.handleRequest(fetchEvent(formRequest('email=a%40b.co')));
        await new Promise((resolve) => setImmediate(resolve));
        const stored = kv.puts.map((put) => put.key + '\n' + put.value).join('\n');
        assert.ok(kv.puts.length > 0, name);
        assert.ok(!stored.includes(K) && !stored.includes('0001'), `${name}: ${stored}`);
        assert.ok(![...w.logs, ...w.errors].join('\n').includes(K), name);
    }
});

test('E7: a 2xx answer that is not valid UTF-8 is not JSON and fails open', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('{"address":"a@b.co","status":"valid","note":"x'), 0xff, ...new TextEncoder().encode('"}')]);
    const w = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: bytes });
    const result = JSON.parse(await w.context.validateEmail('a@b.co', '198.51.100.7'));
    assert.strictEqual(result.message, 'ZeroBounce returned a response that is not JSON');
    // Through the handler the address is forwarded untouched, as for other non-JSON answers.
    const handler = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: bytes });
    await handler.context.handleRequest(fetchEvent(formRequest('email=a%40b.co')));
    assert.strictEqual(new TextDecoder().decode(new Uint8Array(await handler.calls.forwarded[0].arrayBuffer())), 'email=a%40b.co');
});
