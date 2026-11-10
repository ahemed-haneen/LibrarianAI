# Librarian — Features & Optimisations

Librarian keeps a compact, always-current index of your codebase and hands AI agents only what
they need. It runs on top of the **GitHub Copilot subscription your firm already provides**, and
it gets better at picking files the more you use it.

> Open this page in VS Code any time: **Librarian: Show Features** (ⓘ in the sidebar).

---

## At a glance

| Area | What you get | AI cost |
|---|---|---|
| Skeletons | Exported API of every TS/JS file, refreshed on save | Free |
| Import graph | What each file imports and what imports it | Free |
| AI summaries | ~150-word "what / responsibilities / use when / gotchas" per file | Once per API change |
| Retrieval | Ranks files for a task: BM25 + names + graph + task memory | Free |
| Task memory | Learns which files you actually change for which kind of task | Free |
| Setup page | Choose provider and exact model; nothing runs until you save | Free |
| Savings estimate | Replays your own history to measure tokens saved and recall | Free |
| Copilot tools | `#librarianFind`, `#librarianSkeleton`, `#librarianRelated`, `#librarianSave`, `#librarianNotes` in agent mode | Free (the tool itself) |
| Saved chat context | Save a chat's goal, decisions and status. Related future chats get it automatically. | Free, or one request to condense |
| `@librarian` | Chat participant using your selected Copilot model with a compact pack | One normal chat request |
| Context packs | Budgeted prompt you can paste into any AI | Free |
| Firm-wide CI index | Shared index rebuilt on each merge, pulled by everyone | One summary per changed API, firm-wide |
| MCP server | Same tools for JetBrains / Visual Studio Copilot, Claude Code, etc. | Free |

---

## 1. Capabilities

### Codebase index
- **AST skeletons** built with the TypeScript compiler: functions, classes (constructor, methods,
  getters/setters, properties, static/abstract/protected), interfaces, type aliases, enums,
  namespaces, exported constants.
- **Arrow functions keep their signatures** (`export const login: async (user: string) => Promise<Token>`)
  instead of collapsing to `any`.
- **Re-exports and barrels**: `export { a as b } from`, `export * from`, `export * as ns from`,
  `export default …`, `export =`.
- **CommonJS**: `module.exports = { … }`, `exports.name = …`, `require()`.
- **First-sentence JSDoc** of each export is kept, a cheap, high-signal hint.
- Private members (`private`, `#field`) and implementation bodies are dropped.
- Extensions: `.ts .tsx .mts .cts .js .jsx .mjs .cjs` (`.d.ts` and minified files skipped).

### Import graph
- Relative imports are resolved to real files: extensionless, `/index.*`, and Node16-style `.js`
  specifiers that point at `.ts`.
- Used to pull in neighbours of the best matches and to answer "what uses this?".

### AI summaries (optional)
- Generated with **your Copilot subscription** (default), Anthropic, GitHub Models or any
  OpenAI-compatible endpoint (Azure OpenAI, internal gateway).
- Summaries are written for retrieval: *Summary, Responsibilities, Use when, Gotchas*. The
  "Use when" section holds the words a developer would type for that kind of task.

### Retrieval & context packs
- **BM25 ranking** over path, export names, skeleton and summary (camelCase, snake_case and
  digit boundaries are split; light stemming).
- Boosts for **files named in the task** and **exported identifiers mentioned in the task**.
- **Task-memory boost** from similar past tasks, plus **reuse of the exact file set** for
  near-identical tasks.
- **Import-graph expansion** adds related files around the top hits, each with the reason it was picked.
- **Token budget** (default 6,000): top files get summary + signatures, lower ones signatures only,
  and anything left over is listed by path.
- **Freshness flags**: an entry whose source changed since indexing is marked ⚠ stale, so the
  agent knows to check the source.

### Learning: it gets better as you use it
- When Librarian gives out context for a task (tool call, `@librarian` or panel), the files you
  **save during the next 45 minutes** are recorded against that task.
- **Learn from git**: every merged commit becomes "commit message → files changed"
  (`Librarian: Learn from Recent Commits`, or automatically in CI).
- Similar future tasks rank those files higher, and near-identical tasks reuse them directly.
- **Usually changed together** for any file, from the same history (`#librarianRelated`).

### Copilot integration (overlay, not replacement)
- **Language Model Tools** that Copilot agent mode calls by itself:
  - `#librarianFind`: relevant files for a task
  - `#librarianSkeleton`: a file's API and summary without reading it
  - `#librarianRelated`: imports, importers and co-changed files
- **`@librarian` chat participant**: answers with whichever Copilot model you picked, from a
  compact context pack. Sub-commands: `/context` (pack only, no model call), `/related`, `/status`.
- **Copilot instructions**: `Librarian: Install Copilot Instructions` adds a managed block to
  `.github/copilot-instructions.md` telling Copilot to consult the index first. Your own
  content is kept, and re-running only updates the block.

### Firm-wide index (CI)
- `templates/librarian-index.yml`: on every merge it re-indexes **only the changed files**,
  learns from the merged commit, and commits `.trishAI/shared/`.
- Uses **GitHub Models through the workflow's own token** (no personal credentials), or your
  firm's Azure OpenAI / Anthropic key.
- Developers' extensions read the shared index and keep a private **local overlay**
  (`.trishAI/local/`, git-ignored) for their uncommitted work.

### CLI & MCP
- `librarian index | learn | query | status | install-instructions | mcp`. The same core as the
  extension, no VS Code needed.
- `librarian mcp` exposes the three tools over the Model Context Protocol (stdio).

### Setup: you choose the model
- On first run a **Librarian Setup** page opens. Pick the provider (firm's Copilot, Anthropic, or no AI)
  and, for Copilot, the **exact model**, from the models your Copilot actually offers.
- Each model shows a **name-based hint** (*usually low-cost* / *usually premium* / *check your plan*).
  VS Code doesn't expose premium-request multipliers, so treat it as a hint and confirm against your plan.
- **Nothing is pre-selected and nothing is auto-picked.** Until you save, only free skeletons are built.
  If your chosen model disappears, summarising stops and asks you. It never falls back to another model.
- Your `@librarian` chats always use the model you select in the chat window.

### Measuring savings
- **Librarian: Estimate Token Savings** (or click *Est. tokens saved* in the sidebar, or
  `librarian estimate` in a terminal or CI) replays your repository's recent merged commits, plus your recorded
  sessions, as if each task were asked again. It never lets a task learn from itself (*leave-one-out*).
- For each task it compares:
  - **Without Librarian:** reading the files that were changed plus their imports and importers (a conservative stand-in for exploration).
  - **With Librarian:** the context pack, plus reading the changed files (you still edit them), plus exploration for any file the pack missed.
- The report shows average and median tokens saved per task, **recall** (how many of the actually changed
  files the pack found), full-hit rate, a per-task table, and an optional $ figure.
- In VS Code it counts with **your chosen model's own tokenizer** (no chat request is made). Otherwise it uses a ~4 chars/token estimate.
- Not counted: fewer back-and-forth turns, which is often the larger saving on request-metered plans. Small repositories show small savings.

### Saved chat context (notes)
Save what a conversation established (goal, decisions and why, constraints, what was rejected,
status, next steps) and reuse it in later chats instead of explaining it again.

| Where you are | How to save |
|---|---|
| Copilot **agent mode** chat | Say *"save this to librarian memory"* or type `#librarianSave`. Copilot writes the summary from the full conversation; you confirm before it's stored. |
| `@librarian` chat | `@librarian /save` summarises the conversation (one request to the chat's model). `@librarian /save <text>` stores your text as is. |
| Any other chat, or an old one | **Copy All** in the chat → **Librarian: Save Note to Memory** → *From clipboard*. Long text can be condensed with your chosen model. |
| Editor | Select text → right-click → **Save Note to Memory**. |
| Terminal / CI | `librarian note "<title>" --summary "<text>" --files a.ts,b.ts` |

- **Reused automatically:** relevant notes are added to context packs under *Saved context from earlier
  chats* (up to 30% of the budget), and the files they mention rank higher. Ask explicitly with
  `#librarianNotes`, `@librarian /notes <query>` or `librarian notes <query>`.
- **Not a code change:** notes are kept apart from task memory. They never count as files you changed,
  and they live in the git-ignored `.trishAI/local/notes.json`, so they don't show up in `git status`.
- **Updates, not duplicates:** saving again with the same title replaces that note.
- **Team sharing (optional):** **Manage Saved Notes → Share with team** moves a note to
  `.trishAI/shared/notes.json`. Commit that file to share it (this one *is* a git change, on purpose).
- Turn off with `trishAI.notes.enabled`.

### Visibility
- Sidebar **AI Readiness %** counts only *fresh* entries; per-folder `ready/total`.
- Per-file state: **Skeleton + Summary**, **Skeleton**, **Stale**, **Unmapped**.
- **Estimated tokens saved**: full-file tokens of the files Librarian pointed to, minus the
  tokens it actually sent.
- One-click **Refresh N stale file(s)**.

---

## 2. Optimisations (where the savings come from)

| # | Optimisation | Effect |
|---|---|---|
| 1 | **Content-hash incremental indexing** | Unchanged files are never re-parsed or re-summarised. Re-running "Index Workspace" costs nothing. |
| 2 | **Summaries refresh on API change only** (default `onApiChange`) | Editing a function body updates the free skeleton but keeps the paid summary. Switch to `onSourceChange` if you prefer. |
| 3 | **You choose the summary model, explicitly** | The setup page lists your Copilot models with a low-cost/premium hint. Nothing is pre-selected, nothing is auto-picked, and there is no fallback to another model, so premium requests are never spent behind your back. |
| 4 | **Skeleton-first, free by default** | Startup and on-save indexing never call a model. Summaries run only when you ask. |
| 5 | **Shared CI index** | One summary per changed API for the whole firm, instead of one per developer. |
| 6 | **Layer reuse** | A fresh shared entry means no local work at all. Local edits only touch your overlay. |
| 7 | **Token-budgeted packs** | Context stays within a fixed size, whatever the size of the repo. |
| 8 | **Fewer turns** | Better first-shot file selection means fewer "no, look at X" follow-ups. On request-metered Copilot plans this is the main saving. |
| 9 | **Task memory** | File picks get more accurate over time, at no cost. |
| 10 | **Size cap** (`maxFileSizeKB`) | Huge or generated files get a skeleton but never an expensive summary. |
| 11 | **Bounded concurrency + cancellable runs** | Index jobs can be stopped at any time, and finished work is kept. |
| 12 | **Per-file error isolation** | One failing file no longer aborts a folder run. |
| 13 | **Deterministic output** (no timestamps in index files) | CI commits contain only real changes, so diffs stay small and reviewable. |
| 14 | **mtime-cached hashing** in the sidebar | Refreshing the tree doesn't re-read unchanged files. |

### A note on how Copilot meters usage
Many Copilot business plans count **requests** (scaled by a per-model multiplier), not tokens.
There, Librarian saves quota mainly through **#3, #5 and #8**: background work goes to cheap
models, it is shared across the firm, and you need fewer back-and-forth prompts. Smaller contexts
(#7) also help answer quality and keep long agent sessions within the context window. Check
what your firm's plan actually meters.

---

## 3. Safety & privacy
- Anthropic API key in **VS Code Secret Storage** (old plain-text setting migrated automatically).
- Webview locked down with a **Content Security Policy** and nonce.
- Summaries are sent only to the provider you configure. Set `aiProvider: none` for a fully
  local, skeleton-only index.
- `.trishAI/local/` is git-ignored, so personal task history never leaves your machine.

---

## 4. Settings

| Setting | Default | Purpose |
|---|---|---|
| `trishAI.aiProvider` | `copilot` | `copilot`, `anthropic` or `none` |
| `trishAI.copilotModel` | *(empty)* | Exact Copilot model id for summaries, set via **Open Setup**. Empty means no summaries. |
| `trishAI.anthropicModel` | `claude-haiku-5-5` | Model when the provider is `anthropic` |
| `trishAI.contextRefreshPolicy` | `onApiChange` | When summaries go stale |
| `trishAI.autoUpdateSkeletons` | `true` | Re-extract on save (free) |
| `trishAI.autoIndexOnStartup` | `true` | Background skeleton pass (free) |
| `trishAI.promptTokenBudget` | `6000` | Max context-pack size |
| `trishAI.maxFileSizeKB` | `100` | No summaries above this size |
| `trishAI.concurrency` | `2` | Parallel summary requests |
| `trishAI.writeLayer` | `local` | `local` overlay, or `shared` if you maintain the index without CI |
| `trishAI.learning.enabled` | `true` | Record edits after Librarian requests |
| `trishAI.costPerMillionTokens` | `0` | Optional price for an indicative cost in the savings estimate |
| `trishAI.notes.enabled` | `true` | Include relevant saved notes in context packs |

---

## 5. Commands

| Command | What it does |
|---|---|
| Librarian: Save Note to Memory (chat context) | Save context from the clipboard, a selection or typed text |
| Librarian: Manage Saved Notes | Open, share with team, or delete notes |
| Librarian: Open Setup (choose model) | First-run page: provider and exact model. Opens automatically until you choose. |
| Librarian: Estimate Token Savings | Replays your git history and sessions; opens a report |
| Librarian: Index Workspace | Incremental index of everything (only changed files cost anything) |
| Librarian: Build Skeletons Only (no AI) | Free full pass |
| Librarian: Refresh Stale Entries | Re-index files that changed since indexing |
| Librarian: Index (skeleton + summary) / Force Re-index | Per file or folder from the sidebar |
| Librarian: Build Context Pack | Panel: describe a task, get a pack on the clipboard |
| Librarian: Install Copilot Instructions | Adds the "use the index first" block |
| Librarian: Learn from Recent Commits | Seeds task memory from git history |
| Librarian: Set Anthropic API Key | Stores the key in secure storage |
| Librarian: Show Index Status / Show Features | Status summary / this page |
