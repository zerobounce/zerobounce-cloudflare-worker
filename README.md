# zerobounce-cloudflare-worker
Cloudflare Worker-based email validation

## Cloudflare Worker-based email validation with the ZeroBounce Email Validator
The ZeroBounce email validator now officially integrates with Cloudflare Workers to assist with email list cleaning. Through Cloudflare Worker’s super-computing platform Edge, you can integrate with ZeroBounce’s real-time email validation to prevent bounced emails and spam complaints while improving your email deliverability in real time.
## How Cloudflare Worker’s email validation middleware works
The Cloudflare worker intercepts any incoming POST requests on the route where it’s deployed. In other words, it examines any email address entered into your website form, validates it, and rejects or accepts the address based on the results.

The integration currently allows for

✓ AJAX email validation

✓ XMLHttpRequest

Note - JSON email validation is not yet supported and may arrive in a future update.


You can easily set up your email validation middleware by

1. Creating Cloudflare Workers KV storage for your validation logs
2. Creating the worker
3. Establishing variables for your ZeroBounce API key, timeout rules, and email validation status
4. Add a binding to store your logs
5. Set up the route for your Cloudflare worker
