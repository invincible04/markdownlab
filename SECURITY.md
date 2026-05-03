# Security Policy

## Reporting a Vulnerability

**Do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Please report vulnerabilities using GitHub's Private Vulnerability Reporting:

- Go to the [Security tab](https://github.com/invincible04/markdownlab/security) of this repository.
- Click **Report a vulnerability**.
- Fill out the advisory form.

This creates a private discussion visible only to the maintainers. We will acknowledge receipt as soon as practical, investigate, and publish an advisory with credit if the report is valid.

If for some reason you cannot use GitHub's private reporting, you may contact the maintainer directly via the contact information on [their GitHub profile](https://github.com/invincible04).

## What to Include

A good report usually contains:

- The version, commit SHA, or deployment URL affected.
- A clear description of the issue.
- Reproduction steps, ideally with a minimal test case.
- The impact you foresee (data disclosure, XSS, CSP bypass, denial of service, etc.).
- Any mitigations or workarounds you are aware of.

You do not need to provide a fix. A clear reproduction is enough.

## Scope

In scope:

- Vulnerabilities in the MarkdownLab source hosted in this repository.
- Misconfigured security headers (`Content-Security-Policy`, `X-Frame-Options`, etc.) in `vercel.json`, `_headers`, or `netlify.toml`.
- Sandbox escapes in the Markdown render pipeline (marked, DOMPurify, Mermaid, KaTeX) as configured here — please also report upstream.
- Service worker cache-poisoning or privilege issues.
- Privacy-impacting network calls not documented in the README.

Out of scope:

- Vulnerabilities in third-party CDN providers (jsDelivr, Google Fonts). Report those upstream.
- Issues that require a compromised origin or browser.
- Missing headers that do not have a demonstrable impact in a modern browser.
- Social-engineering, spam, or abuse reports for the deployed site — report those to the hosting provider.
- Denial-of-service attacks on the live demo at `markdownlab.vercel.app`.

## Supported Versions

Only the `main` branch and the latest deployment are supported. This is a small single-maintainer project; there are no long-term-support branches.

| Version        | Supported |
| -------------- | :-------: |
| `main` (HEAD)  |     Yes    |
| Older commits  |     No     |

## Response Expectations

This is a volunteer-maintained project. We aim for:

- **Acknowledgement** within 7 days.
- **Initial assessment** within 14 days.
- **Fix or mitigation** on a best-effort basis depending on severity.

There is no service-level agreement. Critical reports will be prioritized.

## Disclosure

We prefer coordinated disclosure. Once a fix is shipped, a GitHub Security Advisory will be published with credit to the reporter (unless anonymity is requested). Please do not publish details of an unpatched vulnerability.

## Thanks

Thank you for taking the time to report responsibly. It helps everyone using MarkdownLab, including its forks.
