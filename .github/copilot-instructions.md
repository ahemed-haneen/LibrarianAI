# Copilot instructions

<!-- librarian:start -->
## Codebase index (Librarian)

This repository has a pre-built index in `.trishAI/` that describes every source file's public API
and purpose. Use it to keep context small and avoid unnecessary file reads.

1. **Before reading source files for a task**, call the `#librarianFind` tool with the task description.
   It returns the most relevant files with their signatures and summaries, picked using past changes.
2. To inspect a specific file's API without reading it, call `#librarianSkeleton` with its path.
3. Before changing a file's exports, call `#librarianRelated` to see what imports it.
4. If tools are unavailable, read `.trishAI/shared/files/<path>.skeleton.md` (or `.trishAI/local/files/...`)
   instead of the full source where signatures are enough.
5. Open full source files only for the parts you need to edit or whose implementation matters.
6. Entries marked "stale" may be outdated: confirm against the source before relying on them.
7. When the user asks to **save / remember this chat or task**, call `#librarianSave` with a short title and a
   summary you write from the conversation (goal, decisions and why, constraints, status, next steps, files involved).
8. When the user refers to earlier work ("what did we decide…", "continue the … task"), call `#librarianNotes`.
   Relevant saved notes are also included automatically in `#librarianFind` results.
<!-- librarian:end -->
