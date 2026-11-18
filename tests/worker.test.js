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

test('a media type that merely contains a form type is not treated as one', async () => {
    const { context, calls } = loadWorker({ API_KEY, VALID_STATUS: ['valid'] }, { validationResponse: { address: 'test@example.com', status: 'invalid' } });

    await context.handleRequest(fetchEvent(formRequest('email=bad%40example.com', { headers: { 'content-type': 'text/plain; note="application/x-www-form-urlencoded"' } })));

    assert.strictEqual(calls.validation.length, 0);
    assert.strictEqual(await calls.forwarded[0].text(), 'email=bad%40example.com');
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

test('H1: a filename (or filename*) marks a file; a filename that quotes name="email" does not rename the part', async () => {
    const file = 'Content-Disposition: form-data; name="doc"; filename="name=\\"email\\"; x.txt"\r\n\r\nsomeone@x.com';
    const star = 'Content-Disposition: form-data; name="email"; filename*=UTF-8\'\'a.txt\r\n\r\nsomeone@x.com';
    const { calls } = await runHandler(mpRequest(mpBody(file, star)));

    assert.strictEqual(calls.validation.length, 0);

    // The quoted filename is not the field name: the part is named "doc" and is a file.
    const text = mpBody('Content-Disposition: form-data; name="x"; filename="a; name=email"\r\n\r\nsomeone@x.com');
    assert.strictEqual((await runHandler(mpRequest(text))).calls.validation.length, 0);
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
        ['your-email=b%40x.com&email=a%40x.com&email=a%40x.com', 'your-email=INVALID&email=a%40x.com&email=a%40x.com'],
        ['email=junk&email=a%40x.com', 'email=INVALID&email=a%40x.com'],
        ['email=a%40x.com&email=&n=1', 'email=a%40x.com&email=&n=1'],
        ['contact=a%40x.com&contact=b%40x.com&email2=c%40x.com', 'contact=a%40x.com&contact=INVALID&email2=c%40x.com'],
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

    assert.strictEqual(calls.validation[0].url.searchParams.get('email'), 'b%40x.com'.replace('%40', '@'));
    assert.strictEqual(text, '%3Femail=zz%40x.com&?email=a%40x.com&email=b%40x.com');

    const only = await runHandler(formRequest('?email=a%40x.com'), { status: 'valid' });
    // Found as the first field holding an address, not as "email".
    assert.strictEqual(only.calls.validation.length, 1);
    assert.ok(only.logs.some((line) => line.startsWith('Matched email')));
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

test('Low: only the exact JSON keys email and your-email are read', async () => {
    const make = (form) => new Request('https://example.com/f', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ form: JSON.stringify(form) }),
    });
    for (const form of [{ email_password: 'hunter2secret' }, { emailConfirm: 'a@x.com' }, { Email: 'a@x.com' }]) {
        const worker = await runHandler(make(form));
        assert.strictEqual(worker.calls.validation.length, 0, JSON.stringify(form));
        for (const line of worker.logs) assert.ok(!line.includes('hunter2secret'), line);
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
        ['[valid', 'valid', true], // not JSON: one entry "[valid"
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
