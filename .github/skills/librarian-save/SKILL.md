---
name: librarian-save
description: Save this conversation to Librarian memory for future chats.
argument-hint: "[optional extra note]"
disable-model-invocation: true
---
<!-- librarian:managed -->
Summarise this conversation (goal, key decisions and why, constraints, what was rejected, status, next steps, under 250 words) and call `#librarianSave` with a short specific title, that summary and the workspace-relative files that matter. Add anything the user typed after the command.
