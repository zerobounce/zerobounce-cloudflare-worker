# Contributing to the ZeroBounce Cloudflare Worker

Thank you for your interest in contributing. This document explains how to get set up and submit changes.

## Code of Conduct

By participating in this project, you agree to uphold our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

See the [README](README.md) for what the Worker does, the environment bindings it reads, and how to run the test suite.

You need Node.js 22 or newer. There are no dependencies to install:

```bash
npm run lint   # node --check on the Worker source
npm test       # node --test, offline
```

## How to Contribute

### Reporting Bugs

Open an [issue](https://github.com/zerobounce/zerobounce-cloudflare-worker/issues) and include:

* Environment details (Worker route, content type of the request, Node version if the problem is in the tests)
* Steps to reproduce
* Expected vs actual behavior
* Relevant code or error messages

Never paste an API key, a real submitted email address, or a raw request body into an issue.

### Suggesting Changes

* Check existing issues and pull requests first.
* Open an issue to discuss larger changes before coding.

### Submitting Changes

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** and add or update tests where relevant.

3. **Run the test suite** (see above) before submitting. Tests must stay offline: no change may call the live ZeroBounce API.

4. **Commit** with a clear message (e.g. `Add X`, `Fix Y`).

5. **Push** your branch and open a **Pull Request** against `main`.

6. In the PR description, briefly explain what changed and why. Link any related issues.

Maintainers will review and may request changes. Once approved, your PR can be merged.

## Releases (maintainers)

There is no package to publish. The Worker is deployed from the script in this repository, and the integration guide at
<https://www.zerobounce.net/docs/api-integrations/cloudflare-worker> links to it. When the script changes in a way users
can see, update the README and that guide in the same pass.

## Questions

* [ZeroBounce API docs](https://www.zerobounce.net/docs/)
* [Project homepage](https://zerobounce.net)
* Contact: **integrations@zerobounce.net**

Thanks for contributing.
