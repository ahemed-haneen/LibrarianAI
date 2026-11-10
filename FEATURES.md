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
| Copilot tools | `#librarianFind`, `#librarianSkeleton`, `#librarianRelated` in agent mode | Free (the tool itself) |
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
| 3 | **Cheap models first** for background work | `copilotModelFamilies` is tried in order. Put your plan's non-premium models first, and keep premium requests for real tasks. |
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
| `trishAI.copilotModelFamilies` | `gpt-4.1, gpt-5-mini, gpt-4o-mini, gpt-4o` | Preference order for background summaries |
| `trishAI.anthropicModel` | `claude-haiku-5-5` | Model when the provider is `anthropic` |
| `trishAI.contextRefreshPolicy` | `onApiChange` | When summaries go stale |
| `trishAI.autoUpdateSkeletons` | `true` | Re-extract on save (free) |
| `trishAI.autoIndexOnStartup` | `true` | Background skeleton pass (free) |
| `trishAI.promptTokenBudget` | `6000` | Max context-pack size |
| `trishAI.maxFileSizeKB` | `100` | No summaries above this size |
| `trishAI.concurrency` | `2` | Parallel summary requests |
| `trishAI.writeLayer` | `local` | `local` overlay, or `shared` if you maintain the index without CI |
| `trishAI.learning.enabled` | `true` | Record edits after Librarian requests |

---

## 5. Commands

| Command | What it does |
|---|---|
| Librarian: Index Workspace | Incremental index of everything (only changed files cost anything) |
| Librarian: Build Skeletons Only (no AI) | Free full pass |
| Librarian: Refresh Stale Entries | Re-index files that changed since indexing |
| Librarian: Index (skeleton + summary) / Force Re-index | Per file or folder from the sidebar |
| Librarian: Build Context Pack | Panel: describe a task, get a pack on the clipboard |
| Librarian: Install Copilot Instructions | Adds the "use the index first" block |
| Librarian: Learn from Recent Commits | Seeds task memory from git history |
| Librarian: Set Anthropic API Key | Stores the key in secure storage |
| Librarian: Show Index Status / Show Features | Status summary / this page |
