<!--
  Thank you for the PR. A few quick housekeeping notes:
  - If this is non-trivial, please link an issue where the approach was agreed.
  - Keep PRs focused. Unrelated changes should go in separate PRs.
  - See CONTRIBUTING.md for the full checklist if this is your first contribution.
-->

## Summary

<!-- One or two sentences. What does this change do, from a user's perspective? -->

## Related issue

<!-- "Fixes #123" closes the issue on merge. Use "Refs #123" for partial relation. -->
Fixes #

## Type of change

<!-- Tick one. Leave the rest. -->

- [ ] Bug fix (no behavioral changes beyond fixing the bug)
- [ ] New feature (adds user-visible functionality)
- [ ] Performance improvement
- [ ] Refactor (no functional change)
- [ ] Documentation
- [ ] Build / CI / tooling
- [ ] Other (describe below)

## How was this tested?

<!--
  MarkdownLab has no automated test suite. Describe the manual verification you did.
  Browsers, viewport sizes, edge cases, what you clicked on.
-->

- Browsers tested:
- Viewport(s):
- Edge cases exercised:

## Checklist

<!-- Tick each item. Unticked items will likely delay review. -->

- [ ] Changes follow the existing code style (vanilla ES modules, SVG icons, CSS custom properties, terse WHY-only comments).
- [ ] No new runtime dependencies were added, OR the new dependency is CDN-pinned, added to `service-worker.js` `CDN_PRECACHE` / `CDN_PREFIXES`, allowed in the CSP, and justified below.
- [ ] Keyboard navigation and focus order still work for all interactive elements I touched.
- [ ] Mobile layout and touch targets (≥ 44px) still work.
- [ ] If inline `<script>` in `index.html` was modified, the SHA-256 hash was recomputed and updated in `vercel.json`, `_headers`, and `netlify.toml`.
- [ ] If a same-origin file was added or removed, `service-worker.js` `SHELL` was updated accordingly.
- [ ] `README.md` was updated if user-visible behavior changed.

## Screenshots / screen recordings

<!-- Before/after screenshots for visual changes. Skip if not applicable. -->

## Notes for the reviewer

<!-- Anything the reviewer should focus on, anything you're unsure about, follow-ups you'd like to defer. -->
