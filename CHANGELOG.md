# Change Log

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
