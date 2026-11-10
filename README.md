# Librarian (TrishAI) — VS Code extension

Makes the **GitHub Copilot subscription your firm already provides** go further. Librarian keeps
a compact, always-current index of the codebase (signatures, short summaries, the import graph
and what changed for past tasks) and gives Copilot only what a task needs. It **learns from use**,
so file picks get better over time, and in CI it builds **one shared index per merge for the
whole firm**.

**Full list of capabilities and optimisations: [FEATURES.md](FEATURES.md)**, also available in
VS Code via *Librarian: Show Features*.

## How it fits with Copilot

You keep working in Copilot Chat. Librarian runs alongside it:

| Layer | How |
|---|---|
| **Copilot agent mode calls Librarian itself** | Language Model Tools `#librarianFind`, `#librarianSkeleton`, `#librarianRelated` |
| **Copilot is told to use them** | `Librarian: Install Copilot Instructions` → `.github/copilot-instructions.md` |
| **Explicit hand-off** | `@librarian <task>` in Copilot Chat (uses the model you picked), `/context` for the pack only |
| **Any other AI** | *Build Context Pack* panel copies a budgeted prompt to the clipboard |
| **Other IDEs / agents** | `librarian mcp` ([docs/MCP.md](docs/MCP.md)) |

## Quick start

1. Install the extension and open your repository. Skeletons build in the background (free).
2. The **Librarian Setup** page opens. Choose the provider and the **exact Copilot model** for summaries.
   Nothing is pre-selected, and no summaries run until you save.
3. **Librarian: Estimate Token Savings** shows what your own history says you'd save.
4. Run **Librarian: Install Copilot Instructions** and commit the file.
5. Optional: **Librarian: Index Workspace** (AI summaries) and **Learn from Recent Commits** (task memory).
6. Work as usual in Copilot agent mode, or ask `@librarian`.

For the firm-wide setup see **[docs/CI.md](docs/CI.md)**.

## Architecture

```
src/
  core/                      VS Code–free; shared by extension, CLI, CI and MCP
    analyzer.ts              TypeScript-AST skeletons + import extraction
    sourceFiles.ts           single "which files are indexed" rule (git ls-files aware)
    indexStore.ts            shared/local layers, manifest, freshness by content hash
    indexer.ts               incremental indexing; summaries only when the API changes
    retrieval.ts             BM25 + names + import graph + task memory, token budget
    taskMemory.ts            learning from edits and merged commits
    librarian.ts             the service every front end calls
    tools.ts / mcpServer.ts  tool contract + MCP stdio server
    llm.ts                   Anthropic, GitHub Models / OpenAI-compatible clients
    savings.ts               token-savings estimate replayed on git history
    modelHints.ts            low-cost / premium hint from a model's name
    copilotInstructions.ts   managed block in .github/copilot-instructions.md
  vscode/
    copilotLlm.ts            vscode.lm (your Copilot), only the exact model you chose
    setupPanel.ts            first-run setup page (provider + model)
    lmTools.ts               Copilot agent-mode tools
    chatParticipant.ts       @librarian
    taskTracker.ts           links saved files to the active task
  extension.ts, coverageTreeProvider.ts, librarianPanel.ts
  cli.ts                     `librarian` command (CI, MCP, scripting)
templates/librarian-index.yml  GitHub Action for the shared index
```

Index layout (in each indexed repository):

```
.trishAI/
  shared/   committed by CI: manifest.json, memory.json, files/<path>.skeleton.md|.context.md
  local/    your overlay + personal task history (git-ignored)
```

## Development

```bash
pnpm install
pnpm run compile      # type-check + lint + bundle (dist/extension.js, dist/cli.js)
pnpm test             # core unit tests (node:test, no VS Code download)
pnpm run test:vscode  # extension-host tests
node dist/cli.js --help
```

Requires VS Code `^1.134.0`. Built with TypeScript 6 and bundled with esbuild.
