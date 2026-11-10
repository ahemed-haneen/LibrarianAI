# Testing Librarian on a real repository

About 20–30 minutes. You need VS Code **1.134 or newer**, Node 20+, pnpm, and GitHub Copilot +
Copilot Chat installed and signed in (your firm's account).

## 0. Build and launch

```bash
git clone https://github.com/ahemed-haneen/LibrarianAI.git
cd LibrarianAI
git checkout optimise-assistant
pnpm install
pnpm test            # 18 core tests, should all pass
code .
```

In VS Code: **Run and Debug** (Ctrl/Cmd+Shift+D) → choose **Run Extension on a repository…** → F5 →
paste the absolute path of the repo to test (a real TypeScript/JavaScript repo with some git history).

A second window, the *Extension Development Host*, opens on that repo with Librarian loaded.
Your other extensions (Copilot included) load too. Logs and errors appear in the **first** window's
Debug Console.

> Librarian writes into `<repo>/.trishAI/`. To keep the test repo's `git status` clean while
> experimenting, add `.trishAI/` to `<repo>/.git/info/exclude`.

## 1. First run: setup page (model choice)

**Expect:** about 1.5 s after the window opens, **Librarian Setup** appears.
- Nothing is selected, and **Save choice** is disabled.
- Choose *Firm's GitHub Copilot*. The list shows the models your Copilot offers, with
  *usually low-cost* / *usually premium* / *check your plan* badges.
- Save stays disabled until you click a model. Pick a low-cost one and save.

**Check:** Settings → search `trishAI.copilotModel` shows the exact id you picked.
Close the window and relaunch: the page should **not** reappear (reopen it with ⚙ in the sidebar).

## 2. Sidebar and free indexing

Open the **book icon** in the activity bar (*TrishAI Context Tracker*).

**Expect:** a few seconds after startup, *AI Readiness* climbs as skeletons are built (free, no
model calls). Files show **Skeleton** (yellow). Folders show `ready/total`.
- Edit and save any `.ts` file: it stays fresh (it's re-indexed on save).
- Edit a file **without saving**, then **Refresh Coverage**: nothing changes. Then change the file on
  disk from a terminal (e.g. `echo "// x" >> src/foo.ts`) and refresh: it shows **Stale** (orange), and a
  *Refresh N stale file(s)* row appears.

## 3. AI summaries with your chosen model

Click ⚡ next to one small file, or run **Librarian: Index Workspace** for the whole repo (it's
cancellable; start with a folder if the repo is large).

**Expect:**
- The first time, VS Code asks to allow the extension to use Copilot. Allow it.
- Files turn **green** (*Skeleton + Summary*). Open `.trishAI/local/files/<path>.context.md` to read one.
- Run **Index Workspace** again: the summary says *0 generated, N reused*. Unchanged files cost nothing.
- Change only a function **body** in a summarised file and save: the skeleton refreshes, but the
  summary is reused (policy `onApiChange`). Change an **exported signature**: the next index run
  re-summarises just that file.

**Negative test:** set `trishAI.copilotModel` to a bogus id such as `nope`, then index a file.
**Expect:** an error saying that model isn't available and to open Setup. No other model is used.

## 4. Token-savings estimate

Click **Est. tokens saved** in the sidebar (or run **Librarian: Estimate Token Savings**).

**Expect:** a markdown report with average and median savings, recall, full-hit rate, a per-task
table, and the tokenizer line naming your chosen model. Optional: set `trishAI.costPerMillionTokens`
for a $ line. Repos with more history and more files give more meaningful numbers.

## 5. Copilot integration

1. Run **Librarian: Install Copilot Instructions**: `.github/copilot-instructions.md` opens with the
   Librarian block.
2. Open **Copilot Chat** → switch to **Agent** mode → open the tools picker (🛠) and check that the
   five *Librarian* tools are listed and enabled.
3. Ask a real task, e.g. *"Add input validation to the signup endpoint"*.
   **Expect:** Copilot calls *Librarian: findRelevantFiles* early (shown in the chat as a tool call),
   then opens fewer files.
4. Force it explicitly: *"#librarianFind where is pagination implemented?"*
5. `@librarian how does authentication work?` → answer plus a footer like
   *Context: N file(s), ~X tokens (reading them in full ≈ Y)*.
6. `@librarian /context add caching to the user lookup` → the pack only (no model call).
7. `@librarian /related src/<some file>.ts` → imports, importers, co-changed files.
8. `@librarian /status` → coverage, notes and savings so far.

> If the tools don't appear in agent mode, your organisation may have disabled extension tools
> (setting `chat.extensionTools.enabled`). `@librarian` and the copy-paste panel still work.

## 6. Learning (gets better with use)

1. Run **Librarian: Learn from Recent Commits** (e.g. 100). **Expect:** *Learnt N task(s)*.
2. Ask `@librarian /context <a task similar to a past commit message>`. **Expect:** files from that
   commit appear, with the reason *changed in similar task "…"*.
3. Ask `@librarian /context <a new task>`, then edit and save two files. Ask the same kind of task
   again: those files now rank higher, with a *similar task* reason.

## 7. Saved chat context (notes)

1. In an **agent-mode** chat, discuss something (a design decision, say), then type:
   *"save this to librarian memory"*.
   **Expect:** a confirmation dialog showing the title and summary Copilot wrote → **Continue** → saved.
2. Start a **new** chat and ask something related, e.g. *"#librarianFind continue the <topic> work"*.
   **Expect:** a *Saved context from earlier chats* section containing your note.
3. `@librarian /notes` lists notes. `@librarian /notes <query>` searches them.
4. Old chat: in the chat view use **Copy All** (right-click), then **Librarian: Save Note to Memory** →
   *From clipboard*. Long text offers *Condense with <your model>*.
5. **Librarian: Manage Saved Notes** → open / *Share with team* (moves the note to
   `.trishAI/shared/notes.json`) / delete.
6. **Check:** `git status` in the test repo shows no new changes from notes, and **Learn from
   Recent Commits** / task memory didn't change because of them.

## 8. CLI and MCP (optional)

From the LibrarianAI folder, against your test repo:

```bash
node dist/cli.js status --root /path/to/repo
```

```bash
node dist/cli.js query "add retry to the http client" --root /path/to/repo
```

```bash
node dist/cli.js estimate --root /path/to/repo --commits 100
```

MCP: see [MCP.md](MCP.md).

## What to send back if something fails

- The **Debug Console** output from the first window (Librarian errors are logged there).
- The step number and what you expected versus what you saw.
- `node dist/cli.js status --root /path/to/repo` output.
