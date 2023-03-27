# zerobounce-cloudflare-worker
Cloudflare Worker-based email validation

## Cloudflare Worker-based email validation with the ZeroBounce Email Validator
The ZeroBounce email validator now officially integrates with Cloudflare Workers to assist with email list cleaning. Through Cloudflare Worker’s super-computing platform Edge, you can integrate with ZeroBounce’s real-time email validation to prevent bounced emails and spam complaints while improving your email deliverability in real time.
## How Cloudflare Worker’s email validation middleware works
The Cloudflare worker intercepts any incoming POST requests on the route where it’s deployed. In other words, it examines any email address entered into your website form, validates it, and rejects or accepts the address based on the results.

## Cloudflare worker script
https://github.com/zerobounce/zerobounce-cloudflare-worker/blob/main/cloudflare-worker-zerobounce
