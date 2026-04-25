// Markdown example documents. Each is a full document demonstrating a feature surface.
// The welcome doc loads on first visit (no saved content).

export const EXAMPLES = {
  welcome: {
    label: 'Welcome & feature tour',
    icon: '✨',
    description: 'Overview of everything this renderer supports',
    content: `# Welcome to MarkdownLab

A beautifully crafted static site for rendering **Markdown**, **Mermaid** diagrams, **LaTeX math**, and syntax-highlighted code — all client-side, no server required.

> [!TIP]
> Drag-and-drop a \`.md\` file anywhere, or paste content into the editor on the left. The preview updates live as you type.

## What's supported

- **GitHub-Flavored Markdown** — tables, task lists, strikethrough, footnotes, auto-links
- **Mermaid diagrams** — flowcharts, sequence, class, state, ER, Gantt, pie, journey, gitGraph
- **LaTeX math** — inline \`$…$\` and block \`$$…$$\` with full KaTeX support
- **Syntax highlighting** — 190+ languages via highlight.js
- **GitHub alerts** — \`> [!NOTE]\`, \`[!TIP]\`, \`[!WARNING]\`, \`[!CAUTION]\`, \`[!IMPORTANT]\`
- **Export** — download as HTML, print to PDF, or copy to clipboard

## Quick taste

### Fenced code with highlighting

\`\`\`javascript
// Debounced resize observer
function debounce(fn, wait = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}
\`\`\`

### A Mermaid flowchart

\`\`\`mermaid
flowchart LR
  A[User types] --> B{Parser}
  B -->|markdown| C[Marked.js]
  B -->|mermaid block| D[Mermaid]
  B -->|LaTeX| E[KaTeX]
  C --> F[DOMPurify]
  D --> G[SVG]
  E --> H[HTML+MathML]
  F --> I((Preview))
  G --> I
  H --> I
\`\`\`

### Math that actually renders

Inline: Euler's identity is $e^{i\\pi} + 1 = 0$.

Block:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

### Tables

| Feature | Library | Version |
|---|---|:---:|
| Markdown | marked | 12.0.2 |
| Diagrams | mermaid | 10.9.1 |
| Math | katex | 0.16.11 |
| Highlighting | highlight.js | 11.10.0 |
| Sanitization | DOMPurify | 3.2.7 |

### Alerts

> [!NOTE]
> GitHub-style alerts — five flavors, rendered with color-coded borders.

> [!WARNING]
> All HTML is sanitized with DOMPurify to prevent XSS from untrusted markdown.

### Task list

- [x] Render markdown
- [x] Render Mermaid diagrams
- [x] Render LaTeX
- [ ] Ship to GitHub Pages (you do this!)

---

*Try loading the other examples from the top bar to see each feature in depth.*
`,
  },

  mermaid: {
    label: 'Mermaid diagrams',
    icon: '🧩',
    description: 'Flow, sequence, class, state, ER, Gantt, pie, journey, gitGraph',
    content: `# Mermaid Diagram Cookbook

Every kind of diagram Mermaid supports, with working examples.

## 1. Flowchart

\`\`\`mermaid
flowchart TD
  Start([Start]) --> Input[/Read user input/]
  Input --> Validate{Valid?}
  Validate -- Yes --> Process[Process data]
  Validate -- No --> Error[Show error]
  Process --> Save[(Save to DB)]
  Save --> Done([Done])
  Error --> Input
\`\`\`

## 2. Sequence diagram

\`\`\`mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant F as Frontend
  participant A as API
  participant D as Database

  U->>F: Click "Save"
  F->>A: POST /api/documents
  activate A
  A->>D: INSERT
  D-->>A: row id
  A-->>F: 201 Created
  deactivate A
  F-->>U: Toast: "Saved"

  Note over U,D: End-to-end under 200ms in the happy path
\`\`\`

## 3. Class diagram

\`\`\`mermaid
classDiagram
  class Animal {
    +String name
    +int age
    +eat()
    +sleep()
  }
  class Dog {
    +String breed
    +bark()
  }
  class Cat {
    +bool indoor
    +purr()
  }
  Animal <|-- Dog
  Animal <|-- Cat
\`\`\`

## 4. State diagram

\`\`\`mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Loading: fetch()
  Loading --> Success: 2xx
  Loading --> Error: 4xx/5xx
  Success --> Idle: reset()
  Error --> Loading: retry()
  Error --> Idle: cancel()
\`\`\`

## 5. Entity-Relationship

\`\`\`mermaid
erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER ||--|{ LINE_ITEM : contains
  CUSTOMER }|..|{ DELIVERY_ADDRESS : uses
  ORDER {
    int id PK
    date placed_at
    string status
  }
  LINE_ITEM {
    int order_id FK
    int product_id FK
    int qty
    decimal price
  }
\`\`\`

## 6. Gantt

\`\`\`mermaid
gantt
  title Product Launch
  dateFormat  YYYY-MM-DD
  axisFormat  %b %d

  section Design
  Wireframes       :done,    des1, 2026-04-01, 5d
  Visual design    :active,  des2, after des1, 7d

  section Engineering
  Backend API      :         eng1, 2026-04-10, 10d
  Frontend build   :         eng2, after eng1, 8d

  section Launch
  QA pass          :         qa1, after eng2, 3d
  Ship             :crit,    ship, after qa1, 1d
\`\`\`

## 7. Pie chart

\`\`\`mermaid
pie showData title Traffic by source
  "Organic" : 4200
  "Direct"  : 1900
  "Referral": 1400
  "Social"  : 800
\`\`\`

## 8. User journey

\`\`\`mermaid
journey
  title Onboarding flow
  section Sign up
    Land on homepage  : 5: User
    Create account    : 3: User
    Verify email      : 2: User, System
  section First session
    Setup workspace   : 4: User
    Invite team       : 3: User
    Create first doc  : 5: User
\`\`\`

## 9. Git graph

\`\`\`mermaid
gitGraph
  commit id: "init"
  branch feature/search
  checkout feature/search
  commit id: "scaffold"
  commit id: "index"
  checkout main
  merge feature/search tag: "v0.2"
  commit id: "hotfix"
\`\`\`

## 10. Mindmap

\`\`\`mermaid
mindmap
  root((MarkdownLab))
    Parsers
      Marked.js
      marked-footnote
    Renderers
      Mermaid
      KaTeX
      highlight.js
    UX
      Theme toggle
      Drag-drop
      Export
\`\`\`
`,
  },

  math: {
    label: 'LaTeX math',
    icon: '∑',
    description: 'Inline and display math, matrices, integrals, proofs',
    content: `# LaTeX Math with KaTeX

Inline math uses single dollar signs: $E = mc^2$.
Display math uses double dollar signs and centers on its own line.

## Classic identities

Euler's identity — often called the most beautiful equation:

$$
e^{i\\pi} + 1 = 0
$$

Gaussian integral:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

## Calculus

$$
\\frac{d}{dx}\\left[\\int_{a}^{x} f(t)\\,dt\\right] = f(x)
$$

$$
\\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h} = f'(x)
$$

## Linear algebra

A $3 \\times 3$ matrix and its determinant:

$$
A = \\begin{bmatrix}
  a & b & c \\\\
  d & e & f \\\\
  g & h & i
\\end{bmatrix}
\\qquad
\\det(A) = a(ei - fh) - b(di - fg) + c(dh - eg)
$$

## Summations and series

$$
\\sum_{k=0}^{n} \\binom{n}{k} x^{k} y^{n-k} = (x + y)^{n}
$$

$$
\\zeta(s) = \\sum_{n=1}^{\\infty} \\frac{1}{n^{s}}, \\qquad \\Re(s) > 1
$$

## Probability

Bayes' theorem:

$$
P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}
$$

Normal distribution PDF:

$$
f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} \\exp\\!\\left(-\\frac{(x-\\mu)^{2}}{2\\sigma^{2}}\\right)
$$

## Aligned equations

$$
\\begin{aligned}
  (x+y)^2 &= (x+y)(x+y) \\\\
          &= x^2 + xy + yx + y^2 \\\\
          &= x^2 + 2xy + y^2
\\end{aligned}
$$

## Cases

$$
f(x) =
\\begin{cases}
  x^2             & \\text{if } x \\geq 0 \\\\
  -x^2            & \\text{if } x < 0
\\end{cases}
$$

## Greek letters and operators inline

$\\alpha$, $\\beta$, $\\gamma$, $\\Gamma$, $\\pi$, $\\Pi$, $\\sigma$, $\\Sigma$, $\\omega$, $\\Omega$, $\\nabla$, $\\partial$, $\\infty$, $\\aleph$, $\\forall$, $\\exists$, $\\in$, $\\subseteq$, $\\cup$, $\\cap$, $\\rightarrow$, $\\Leftrightarrow$.
`,
  },

  gfm: {
    label: 'GFM showcase',
    icon: '📘',
    description: 'Tables, task lists, footnotes, alerts, strikethrough',
    content: `# GitHub-Flavored Markdown Showcase

## Headings

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

## Emphasis

*Italic* and **bold** and ***both*** and ~~strikethrough~~ and \`inline code\`.

A line with ==highlighted text== (when supported) and a ^superscript^ and a ~subscript~.

## Links & images

[Inline link](https://example.com) and an autolink: <https://example.com>.

![A sample image](https://images.unsplash.com/photo-1534796636912-3b95b3ab5986?w=640 "Unsplash sample")

## Lists

### Unordered

- First item
  - Nested
    - Deeper
- Second item
- Third item

### Ordered

1. Install dependencies
2. Configure the build
3. Deploy to production

### Task list

- [x] Design system
- [x] Markdown parser
- [x] Mermaid renderer
- [ ] Ship to users
- [ ] Measure adoption

## Tables

| Name | Type | Default | Description |
|------|------|:-------:|-------------|
| \`theme\` | string | \`'dark'\` | UI theme — \`'dark'\` or \`'light'\` |
| \`debounce\` | number | \`150\` | Render debounce in ms |
| \`sanitize\` | boolean | \`true\` | Strip unsafe HTML |

With alignment:

| Left | Center | Right |
|:-----|:------:|------:|
| $1.00 | 42 | 3.14 |
| $10.00 | 100 | 2.718 |
| $100.00 | 7 | 1.414 |

## Blockquotes & alerts

> A quote carries the voice of the writer. Keep it short, keep it human.
>
> — Anon.

> [!NOTE]
> Useful information that users should know.

> [!TIP]
> A helpful shortcut or best practice.

> [!IMPORTANT]
> Critical information needed for success.

> [!WARNING]
> Pay attention — risk of data loss.

> [!CAUTION]
> Dangerous — proceed only if you know what you're doing.

## Code

Inline: \`const answer = 42;\`

\`\`\`typescript
interface User {
  id: string;
  email: string;
  createdAt: Date;
}

async function getUser(id: string): Promise<User | null> {
  const res = await fetch(\`/api/users/\${id}\`);
  if (!res.ok) return null;
  return res.json();
}
\`\`\`

\`\`\`python
from dataclasses import dataclass
from datetime import datetime

@dataclass
class User:
    id: str
    email: str
    created_at: datetime

def greet(user: User) -> str:
    return f"Hello, {user.email}!"
\`\`\`

\`\`\`rust
fn fibonacci(n: u32) -> u64 {
    match n {
        0 => 0,
        1 => 1,
        _ => fibonacci(n - 1) + fibonacci(n - 2),
    }
}
\`\`\`

## Footnotes

Here's a sentence with a footnote reference[^1]. And another one[^big].

[^1]: This is the footnote text.
[^big]: Footnotes can contain **multiple paragraphs** and *formatting*.

## Keyboard shortcuts

Press <kbd>Ctrl</kbd> + <kbd>K</kbd> to toggle the theme, or <kbd>Cmd</kbd> + <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> to switch view modes.

## Horizontal rules

---

Above and below are horizontal rules, separating sections cleanly.

---

## Raw HTML (sanitized)

<details>
<summary>Click to expand — inline HTML works too</summary>

Hidden content with **markdown** inside — DOMPurify keeps it safe.

</details>
`,
  },
};
