<div align="center">

# MarkdownLab

**A client-side Markdown, Mermaid, and LaTeX playground that runs entirely in your browser.**

*No server. No build. No account. No telemetry.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Zero build](https://img.shields.io/badge/build-zero-6f42c1)](#how-it-works)
[![Offline capable](https://img.shields.io/badge/runs-100%25_client_side-2ea44f)](#privacy--security)

</div>

---

## What it is

MarkdownLab is a single-page app that turns any Markdown — plus Mermaid diagrams, LaTeX math, and 190+ syntax-highlighted languages — into a live, content-aligned preview. Paste, drag-drop a file, or load a built-in example; the preview updates as you type.

Everything runs in the browser. The moment `index.html` loads, you're already using it. There is no backend, no account, no data leaving your device.

## Why it exists

The typical options for rendering Markdown are either heavyweight editors (Obsidian, Typora, VS Code + extensions), cloud-locked services that want your content, or minimal GitHub renderers that skip math and diagrams. MarkdownLab fills the gap when you need:

- A **shareable link** to a renderer that anyone can open in a browser — no install.
- A **trust-free** preview for sensitive content that must never touch a server.
- A **full-feature** renderer (GFM + Mermaid + KaTeX) without wiring up five packages yourself.
- A **self-hostable** tool you can drop on any static host in under 30 seconds.

## Use cases

<table>
<tr>
<td width="33%" valign="top">

### Engineering

- Preview architecture diagrams and sequence flows before committing to a design doc
- Author RFCs with inline Mermaid for system boundaries, class hierarchies, state machines
- Sketch incident post-mortems with Gantt timelines and journey maps
- Share a reproducible math derivation (KaTeX) with a colleague without LaTeX tooling
- Paste raw GitHub issues / PR bodies to see exactly how GitHub will render them

</td>
<td width="33%" valign="top">

### Research & writing

- Draft academic notes with inline and block equations that render identically on any device
- Prototype data-science notebooks' narrative sections before porting to Jupyter
- Build reading-mode long-form drafts with serif typography and a focused column
- Clean-room writing: no auto-save to the cloud, no autocomplete spying on you

</td>
<td width="33%" valign="top">

### Ops & docs

- Render runbook fragments with syntax-highlighted code and GitHub-style callouts (`[!WARNING]`)
- Preview chart documentation for dashboards before embedding
- Export self-contained HTML or 2× PNG diagrams for reports and slide decks
- Teach Markdown to someone: the split view shows source and output side-by-side, perfectly aligned

</td>
</tr>
</table>

## Capabilities

### Content

- **GitHub-Flavored Markdown** — tables, task lists, strikethrough, footnotes, autolinks
- **GitHub alerts** — `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` with color-coded styling
- **Mermaid** — flowchart, sequence, class, state, ER, Gantt, pie, journey, gitGraph, mindmap
- **LaTeX math** — inline `$x$` and display `$$…$$` via KaTeX, with HTML + MathML output for accessibility
- **Syntax highlighting** — 190+ languages via highlight.js with auto-detection fallback

### Projects & files

- **Project sidebar** — organize your markdown into projects, each with many files; drag-reorder within or across projects
- **File tabs** — open multiple files as tabs, drag to reorder, middle-click or <kbd>⌘W</kbd> to close, <kbd>⌘Tab</kbd> to cycle
- **Per-file autosave** — every file has its own cursor, scroll, and dirty indicator; `●` shows pending writes, clears when saved
- **IndexedDB storage** — stays 100% client-side but side-steps the 5 MB `localStorage` ceiling; localStorage fallback for private mode
- **Fuzzy search** — search across every project and file from the sidebar or the command palette
- **Command palette** — <kbd>⌘P</kbd> opens a unified quick-open and action runner; <kbd>⌘Enter</kbd> creates a new file from the query
- **Folder import** — bring a directory of `.md` files into a new project, preserving the subfolder name
- **Undoable delete** — deleting a file or project shows a toast with a 7-second **Undo** action; no accidental permanent loss
- **Find and replace** — <kbd>⌘F</kbd> / <kbd>⌘H</kbd> opens an inline find bar with case-, word-, and regex-matching

### Editing experience

- **Live preview** — debounced 120 ms render loop, typical end-to-end latency under 40 ms
- **Content-aware scroll sync** — editor ↔ preview stay aligned block-by-block, not by ratio; toggle off with one click
- **Soft-wrapped editor** — long lines wrap visually while the hidden mirror keeps line math correct
- **Line numbers** — gutter positions track soft-wrapped lines exactly and paint immediately on file upload
- **Autosave** — every keystroke persisted to IndexedDB, per file; scroll and cursor positions restored per file on refresh

### Diagrams

- **Interactive lightbox** — click any diagram to zoom, pan, and export
- **Wheel zoom** — calibrated for both mouse wheels and trackpad pinch, with cursor-focal zoom
- **2× PNG export** — rasterized with inlined computed styles and rebuilt foreignObject labels so colors match on-screen output
- **Auto theme** — diagrams redraw when you switch light/dark without re-parsing the document
- **WCAG-audited palette** — every Mermaid text/fill pair meets AA contrast (4.5:1) in both light and dark modes

### Exports

- Download as self-contained HTML (KaTeX + highlight.js CSS inlined when network is reachable; falls back to CDN `<link>` tags otherwise)
- Download Markdown source
- Download as PDF (native `window.print()` inside a hidden, light-themed iframe — produces a true vector PDF with selectable text)
- Copy rendered HTML or raw Markdown

### UX

- **Three views** — editor-only, split, or preview-only; resizable divider
- **Focus mode** — hides all chrome; floating glass dock keeps theme / outline / reading / exit accessible
- **Dark & light themes** — pixel-identical layouts between modes; theme toggle always one click away
- **Reading mode** — opt-in serif typography with a narrower column for long-form
- **Keyboard-first** — shortcuts for every view/theme/file action (press `?` for the cheatsheet)
- **Responsive** — sidebar collapses to a drawer on small screens; tabs stay horizontally scrollable

### Privacy & security

- **100% client-side** — your content never leaves the browser; no analytics or telemetry of any kind
- **Storage lives on YOUR device** — projects and files are stored in the browser's IndexedDB (origin-isolated, never uploaded). You can inspect or delete the data via DevTools → Application → Storage → IndexedDB → `mdlab`
- **DOMPurify sanitization** — hostile HTML in untrusted Markdown cannot execute
- **Strict Mermaid security level** — inline event handlers and external references blocked
- **No tracking, no cookies, no analytics**
- **Offline-capable** — once CDN assets are cached, works without a connection
- **Still a static site** — host on GitHub Pages, Netlify, S3, or serve via `file://`; no backend required

### Accessibility

- Semantic HTML, ARIA roles on dialogs and interactive regions
- Visible focus rings on every focusable surface
- Respects `prefers-reduced-motion`
- KaTeX emits MathML alongside visual output for screen readers
- Keyboard-reachable everywhere — no action requires a mouse

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| <kbd>Ctrl/Cmd</kbd> + <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> | Editor / Split / Preview view |
| <kbd>Ctrl/Cmd</kbd> + <kbd>P</kbd> | Command palette / quick open |
| <kbd>Ctrl/Cmd</kbd> + <kbd>F</kbd> | Find in file |
| <kbd>Ctrl/Cmd</kbd> + <kbd>H</kbd> or <kbd>Ctrl/Cmd</kbd> + <kbd>Shift</kbd> + <kbd>F</kbd> | Find and replace |
| <kbd>Ctrl/Cmd</kbd> + <kbd>B</kbd> | Toggle sidebar |
| <kbd>Ctrl/Cmd</kbd> + <kbd>N</kbd> | New file in active project |
| <kbd>Ctrl/Cmd</kbd> + <kbd>W</kbd> | Close current tab |
| <kbd>Ctrl/Cmd</kbd> + <kbd>Tab</kbd> | Next tab (add <kbd>Shift</kbd> for previous) |
| <kbd>Ctrl/Cmd</kbd> + <kbd>K</kbd> | Toggle theme |
| <kbd>Ctrl/Cmd</kbd> + <kbd>.</kbd> | Toggle focus mode |
| <kbd>Ctrl/Cmd</kbd> + <kbd>L</kbd> | Toggle outline |
| <kbd>Ctrl/Cmd</kbd> + <kbd>O</kbd> | Open file(s) |
| <kbd>Ctrl/Cmd</kbd> + <kbd>S</kbd> | Download Markdown |
| <kbd>F2</kbd> | Rename file (in sidebar) |
| <kbd>/</kbd> | Focus sidebar search |
| <kbd>?</kbd> or <kbd>Ctrl/Cmd</kbd> + <kbd>/</kbd> | Show all shortcuts |
| <kbd>Esc</kbd> | Exit focus / close dialog |
| <kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> | Zoom in / out / fit (diagram viewer) |
| <kbd>Tab</kbd> | Insert two spaces (editor) |

## How it works

```
editor → extractMath → marked → reinjectMath → DOMPurify → Mermaid → postProcess
```

1. A small state machine pulls `$…$` and `$$…$$` out of the source (skipping fenced and inline code), renders each with KaTeX, and leaves placeholders behind.
2. `marked` parses the placeholder-substituted source. A custom renderer emits Mermaid fences as `<div class="mermaid">` so they survive sanitization.
3. Placeholders are swapped back with the pre-rendered KaTeX HTML.
4. `DOMPurify` sanitizes with SVG + MathML allowlisted.
5. The HTML mounts; `mermaid.run({ nodes })` replaces each `.mermaid` div with an SVG.
6. Post-processing adds copy buttons to code blocks, opens external links in new tabs, wires smooth-scroll on anchor links, and attaches the expand control to each diagram.

## Project status

| | |
|---|---|
| **Stability** | Production-ready — used for daily writing |
| **Maintenance** | Active; PRs welcome |
| **Browser support** | Chrome, Firefox, Safari, Edge (last two stable versions) |
| **Bundle size** | 0 bytes shipped — all libraries are CDN-pinned and loaded on demand |
| **Build** | None. `index.html` is the entry point. |

## Libraries

All pinned, all via CDN (jsdelivr). No package manager, no lockfile.

| Library | Version | Purpose |
|---|:---:|---|
| [marked](https://marked.js.org/) | 12.0.2 | Markdown parser |
| [marked-gfm-heading-id](https://github.com/markedjs/marked-gfm-heading-id) | 3.1.3 | Heading anchor IDs |
| [marked-footnote](https://github.com/bent10/marked-extensions) | 1.2.4 | Footnote syntax |
| [mermaid](https://mermaid.js.org/) | 10.9.1 | Diagram rendering |
| [KaTeX](https://katex.org/) | 0.16.11 | Math typesetting |
| [highlight.js](https://highlightjs.org/) | 11.10.0 | Code highlighting |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.2.7 | HTML sanitization |

PDF export uses the browser's native `window.print()` API against a hidden, light-themed iframe — no rasterization library. SVG diagram export is a pure-browser `canvas.toBlob('image/png')` with inlined computed styles. Both are zero-dependency.

## License

[MIT](LICENSE). Fork it, rip pieces out, ship your own version.
