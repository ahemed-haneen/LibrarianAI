# Change Log

## [0.4.0]

### Changed
- **The `@librarian` chat participant is retired.** VS Code deprecated chat participants and the Copilot harness no longer supports them, which showed a "Replace Chat Participant" warning. Everything it did is now available through supported routes:
  - the default answer → the **Librarian** custom agent (`.github/agents/librarian.agent.md`), which calls `#librarianFind` first;
  - `/context`, `/related`, `/status`, `/save`, `/notes` → skills `/librarian-context`, `/librarian-related`, `/librarian-status`, `/librarian-save`, `/librarian-notes` (`.github/skills/`).
- **Install Copilot Instructions** (and `librarian install-instructions`) now also writes the agent and skills. Files you edited yourself (marker removed) are never overwritten.
- **The sidebar's single "AI Readiness %" is now two rows:** **Skeletons %** (free index, fresh vs stale) and **AI summaries %** (summarised vs outdated). The old row reached 100% with zero AI summaries, which read as "fully AI-ready". The summaries row is informational (it opens Setup only when no model is chosen); summarising is started from Index Workspace or the right-click menu, after a confirmation.
- **The sidebar's inline ⚡ and ↻ buttons are now free (skeleton only).** They used to call the model, which could trigger Copilot's access prompt just from clicking near a folder. AI summaries for a file or folder are now **Summarise with AI** in the right-click menu. Clicking the sidebar's **AI summaries** row no longer starts a run, and every command that calls a model (Index Workspace, Refresh Stale, Summarise with AI) asks for confirmation first.
- The Librarian agent now offers once, when a substantial task is finished, to save it to Librarian memory (`#librarianSave`).

### Retrieval and benchmark
- **Better ranking.** Per-language search statistics, test/spec files paired with their source, capped skeletons so more candidates fit the pack, a second-stage rerank by query-word coverage, more candidates (32) and import neighbours (8). On the proxy repo: saved tokens 29% → 59%, median task 6% → 56%.
- **More indexed types.** YAML, proto, GraphQL, HTML, SCSS and `.pyi` (setting `trishAI.extraFileTypes`; JSON is opt-in). Files with no public names get a private-symbol/imports skeleton.
- **Import graph resolves tsconfig `paths`, `baseUrl` and workspace package names**, and Angular `templateUrl`/`styleUrls`. Run **Index Workspace** (or `librarian index --force`) once to rebuild edges.
- **Working context.** `#librarianFind` also uses branch name, open and modified files and diff words.
- **`librarian bench` / `bench-compare`** and `templates/librarian-bench.yml` replay past commits; see `docs/BENCHMARK.md`.

### Added
- **Savings report explains itself.** **Estimate Token Savings** now says why tokens were not saved: the saving with perfect retrieval versus the actual one (so you can tell fixable retrieval misses from structural limits), each task's main cause, every missed file with its reason (ranked below the pack limit, neighbour limit, no public names, too few searchable words, no shared wording), the files missed most often, which commits were left out and why (with the file types involved), and a numbered list of suggestions. A JSON copy of the diagnostics ends the report, so it can be pasted into a chat or issue.
- **Python support.** `.py` files are now indexed: skeletons (functions, classes, methods, class fields, decorators such as HTTP routes, docstring summaries), the import graph (absolute and relative imports) and retrieval. Uses a built-in parser, so no Python install is needed. Virtualenvs and generated `*_pb2.py` files are skipped. Existing indexes pick up Python files on the next **Index Workspace** / **Build Skeletons Only**.
- `#librarianStatus` tool (`librarian_getStatus`), also served over MCP.

## [0.3.0]

### Added
- **Saved chat context (notes):** `#librarianSave` / `#librarianNotes` tools for Copilot agent mode, `@librarian /save` and `/notes`, **Save Note to Memory** (clipboard, selection or typed; optional condensing with your chosen model), **Manage Saved Notes** (open, share with team, delete), and `librarian note` / `librarian notes` in the CLI. Relevant notes are added to context packs automatically and boost the files they mention. Notes are kept separate from task memory and stored in the git-ignored local layer.
- "Run Extension on a repository…" debug configuration.

## [0.2.0]

### Added
- **Librarian Setup** page that opens on first run. You choose the provider and the exact Copilot model, with low-cost/premium hints. Nothing is pre-selected.
- **Estimate Token Savings** (command, sidebar and `librarian estimate`): replays git history and sessions leave-one-out, and reports tokens saved, recall and an optional cost.

### Changed
- Copilot summaries use only the model you chose (`trishAI.copilotModel`). The automatic `copilotModelFamilies` preference and the "any model" fallback are removed.

## [0.1.0]

### Added
- Content-hash **incremental indexing**: unchanged files are skipped, and summaries are regenerated only when a file's public API changes (configurable).
- **Import graph** and graph-aware retrieval.
- **Task memory**: learns from files saved after a Librarian request and from merged commits.
- **BM25 retrieval** with a token budget and freshness flags.
- **Copilot Language Model Tools** (`#librarianFind`, `#librarianSkeleton`, `#librarianRelated`) and the **`@librarian`** chat participant.
- **Install Copilot Instructions** command.
- **Shared (CI) and local index layers**, plus the `templates/librarian-index.yml` GitHub Action.
- **`librarian` CLI** (`index`, `learn`, `query`, `status`, `mcp`, `install-instructions`) and an **MCP server**.
- Cheap-model preference for Copilot summaries; GitHub Models / OpenAI-compatible and Anthropic providers.
- Skeletons now cover default exports, re-exports, arrow-function signatures, getters/setters, CommonJS and JSDoc summaries.
- Sidebar: stale detection, per-folder coverage, estimated tokens saved.
- FEATURES.md and the *Show Features* command.

### Changed
- Anthropic API key moved to VS Code Secret Storage (migrated automatically from settings).
- Summary runs are cancellable and run in parallel with a limit; one failing file no longer aborts a run.
- One shared rule decides which files are indexed (honours `.gitignore` via `git ls-files`).
- Index layout moved to `.trishAI/shared` and `.trishAI/local`.

### Removed
- Hello World command.
