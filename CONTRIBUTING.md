# Contributing to MarkdownLab

Thanks for your interest. This project is small, opinionated, and has a specific architecture to protect. PRs are welcome, but please read this first so your work isn't rejected for reasons you could have avoided.

## Before You Start

- **Open an issue first for anything non-trivial.** A 3-line tweak can be a drive-by PR. A new feature, a refactor, or anything that adds lines of code should start as an issue so we can discuss scope before you invest time.
- **Search existing issues.** Someone may already be working on it, or the idea may have been declined.
- **This is a weekend-friendly project.** Reviews are best-effort. Please be patient.

## What Belongs Here (and What Doesn't)

MarkdownLab is a **zero-build, client-side Markdown workspace**. That constraint is the product. Contributions that break it will not be merged.

**In scope:**
- Bug fixes.
- Accessibility fixes.
- Performance improvements that don't add dependencies.
- Editor/preview/export features that work entirely in the browser.
- Documentation, examples, tests.
- New Markdown syntax support via CDN-pinned `marked` extensions (with a good reason).

**Out of scope:**
- Anything that introduces a build step, `package.json`, bundler, or transpiler.
- Any server-side component, backend, or account system.
- Telemetry, analytics, crash reporting, or any network call that isn't already documented.
- New runtime dependencies beyond the pinned CDN set, unless they replace an existing one with a clear win.
- Features that only make sense with a server (real-time collab, cloud sync, etc. — fork us if you need this).

## Local Development

```bash
git clone https://github.com/invincible04/markdownlab.git
cd markdownlab
python3 -m http.server 8000    # or any static file server
open http://localhost:8000
```

There is no build step, no dev server with hot-reload, no test framework. Edit a file, refresh the browser. That's the loop.

## Code Style

Follow the existing style. Specifically:

- **Vanilla ES modules, no frameworks, no transpilation.** If you need a helper, write it inline.
- **Use the semantic CSS custom properties** already defined (`--bg-elev-1`, `--text`, `--accent-ring`, etc.). No raw hex values in new rules.
- **SVG icons, not emoji or icon fonts.** Stroke 2, 18×18 by default, matching the Lucide aesthetic used throughout.
- **Comments explain _why_, not _what_.** Terse. One line usually. The code should already say what it does.
- **No dead code, no commented-out blocks, no TODO litter.** If you want to mark follow-up, open an issue.
- **Preserve accessibility invariants.** Every interactive element must be keyboard-reachable, have a visible focus ring, and (where needed) ARIA semantics. Do not regress.

## The Zero-Build Invariant

This is the hill this project dies on. Do not add:

- `package.json`, `yarn.lock`, `pnpm-lock.yaml`, or any lockfile.
- A build tool (Vite, Rollup, esbuild, Parcel, webpack, etc.).
- TypeScript compilation, JSX, SCSS, or any syntax that requires transforming.
- Node-only imports that would need a polyfill for the browser.

If you find something that looks like it requires a build, there's almost always a pure-browser alternative. Ask in an issue.

## Adding a Dependency

If you have a very good reason to add a CDN library:

1. Pin an exact version: `cdn.jsdelivr.net/npm/NAME@X.Y.Z/...`. No `@latest`, no range specifiers.
2. Add the pinned URL to `service-worker.js` `CDN_PRECACHE` (so offline users still get it) and `CDN_PREFIXES` (so runtime fetches are cached).
3. Add the origin to `Content-Security-Policy` in `vercel.json` and `_headers` if it's not already allowed.
4. Document what the library does and why it was chosen in the PR description.
5. Expect pushback. The existing 7-library set was chosen deliberately.

## The CSP Hash Footgun

`index.html` contains one inline `<script>` block (the async CSS loader). Its SHA-256 hash is pinned in `vercel.json`, `_headers`, and `netlify.toml`. **If you edit that inline script, CSP will block it and the site will white-screen.**

To recompute the hash after editing:

```bash
python3 -c "
import hashlib, base64, re
html = open('index.html').read()
script = re.search(r'<script>(.*?)</script>', html, re.S).group(1)
print('sha256-' + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode())
"
```

Paste the new hash into all three config files. CI will catch drift, but fixing it before pushing saves a round-trip.

## Pull Request Checklist

- [ ] Opened an issue first if the change is non-trivial.
- [ ] Tested manually in at least one Chromium and one non-Chromium browser (Firefox or Safari).
- [ ] Keyboard navigation still works (Tab order, focus ring, Escape to close modals).
- [ ] Mobile layout still works (narrow viewport, touch targets ≥ 44px).
- [ ] No new dependencies, or dependencies documented per the section above.
- [ ] If inline HTML `<script>` was changed: CSP hash recomputed in `vercel.json`, `_headers`, and `netlify.toml`.
- [ ] If a new same-origin file was added: added to `service-worker.js` `SHELL` array if it should be offline-available.
- [ ] `README.md` updated if user-visible behavior changed.
- [ ] Commit messages follow the style below.

## Commit Messages

Short imperative subject under 72 characters, prefixed with a type. If the change is non-trivial, add a blank line and a flat dashed-bullet body.

```
type: short imperative summary

- one thing you did
- another thing
- at most five bullets, no paragraphs
```

Types in use: `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `build`, `test`.

## Code of Conduct

By participating, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security Issues

Do not report security vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

By submitting a contribution, you agree that your work is licensed under the same [MIT License](LICENSE) that covers the rest of the project.
