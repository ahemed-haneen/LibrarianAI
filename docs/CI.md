# Firm-wide index on merge

Goal: **one indexing pass per code change for the whole firm.** Developers pull the result
and pay nothing to index.

```
PR merged to main
  └─ GitHub Action (templates/librarian-index.yml)
       1. git diff <before>..<after>          → changed source files only
       2. librarian index --layer shared      → skeletons + import graph (free)
                                              → summaries only where the public API changed
       3. librarian learn --range …           → "commit message → files changed" task memory
       4. commit .trishAI/shared  [skip ci]
Developers: git pull → extension reads .trishAI/shared + private .trishAI/local overlay
```

## Setup (per repository)

1. Copy `templates/librarian-index.yml` to `.github/workflows/librarian-index.yml`.
2. Choose the summary provider in the workflow's `env`:
   | `PROVIDER` | Auth | Notes |
   |---|---|---|
   | `github-models` (default) | Workflow `GITHUB_TOKEN` + `permissions: models: read` | Organisation must allow GitHub Models. `MODEL` e.g. `openai/gpt-4.1-mini`. |
   | `openai` | Secret `LIBRARIAN_API_KEY`, variable `LIBRARIAN_BASE_URL` | Azure OpenAI v1 endpoint (`https://<resource>.openai.azure.com/openai/v1`) or internal gateway. |
   | `anthropic` | Secret `ANTHROPIC_API_KEY` | `MODEL` e.g. `claude-haiku-5-5`. |
   | `none` | — | Skeletons, graph and memory only. Zero AI spend. |
3. If the Librarian repository is private, add a secret `LIBRARIAN_TOOL_TOKEN` with read access to it.
4. If `main` is protected, let the workflow push: add GitHub Actions (or a GitHub App you use for
   bots) to the ruleset's bypass list for the `.trishAI/shared/**` commits.
5. Run it once by hand (**Actions → Librarian index → Run workflow**, tick *full*) to build the
   initial index. After that every merge only processes what changed.
6. Run `librarian install-instructions` (or the VS Code command) once and commit
   `.github/copilot-instructions.md`, so Copilot uses the index for everyone.

## Developer settings

Leave `trishAI.writeLayer` at `local` (the default). The extension then:
- reads `.trishAI/shared` (from CI) and `.trishAI/local` (yours, git-ignored),
- uses whichever entry matches the file **as it is on disk now**,
- refreshes only your changed files in `local/`. A file that is fresh in `shared/` costs nothing.

## Writing commit messages that teach well

Task memory learns from the merged commit message (squash-merge title + body). Messages that
describe the *task* ("Add VAT to EU invoices") teach better than ones that describe the *diff*
("update invoice.ts"). Commits with `[skip ci]` or `[librarian skip]` are ignored, as are commits
touching more than 40 source files (too broad to be a useful signal).

## Approvals checklist (for your security team)

- Source code of **changed files** is sent to the configured model provider, once per API change.
- No developer credentials are used in CI. GitHub Models uses the workflow token.
- Output is plain markdown/JSON committed to the repository, so it is reviewable like any other file.
- `aiProvider/PROVIDER = none` gives a fully local index if external models aren't approved yet.
