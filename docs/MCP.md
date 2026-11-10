# Using Librarian from other agents (MCP)

Inside VS Code you don't need MCP: the extension registers the tools with Copilot directly.
Use the MCP server for **Copilot in JetBrains / Visual Studio**, **Claude Code**, or any other
MCP client.

Build once:

```bash
pnpm install && node esbuild.js --production
```

The server runs on stdio from the repository you want to query:

```bash
node /path/to/LibrarianAI/dist/cli.js mcp --root /path/to/your/repo
```

### Example client config

```json
{
  "mcpServers": {
    "librarian": {
      "command": "node",
      "args": ["/path/to/LibrarianAI/dist/cli.js", "mcp", "--root", "."]
    }
  }
}
```

Tools exposed: `librarian_findRelevantFiles`, `librarian_getSkeleton`, `librarian_getRelatedFiles`.
They are read-only and make no model calls.
