import * as readline from 'readline';
import { Librarian } from './librarian';
import { TOOL_DEFS } from './tools';

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0) exposing the Librarian tools.
 * Lets other MCP clients — Copilot in JetBrains/Visual Studio, Claude Code, etc. — use the same index.
 * stdout carries protocol messages only; diagnostics go to stderr.
 */
export function runMcpServer(root: string, version: string): void {
  const lib = new Librarian(root);
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    if (!line.trim()) {
      return;
    }
    let req: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const reply = (result: unknown) => req.id !== undefined && send({ jsonrpc: '2.0', id: req.id, result });
    const fail = (code: number, message: string) => req.id !== undefined && send({ jsonrpc: '2.0', id: req.id, error: { code, message } });

    try {
      switch (req.method) {
        case 'initialize':
          reply({
            protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'librarian', version },
            instructions: 'Call librarian_findRelevantFiles before reading source files for a task.',
          });
          break;
        case 'ping':
          reply({});
          break;
        case 'tools/list':
          reply({ tools: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
          break;
        case 'tools/call': {
          const name = String(req.params?.name ?? '');
          const tool = TOOL_DEFS.find((t) => t.name === name);
          if (!tool) {
            fail(-32602, `Unknown tool: ${name}`);
            break;
          }
          const out = tool.run(lib, (req.params?.arguments as Record<string, unknown>) ?? {});
          reply({ content: [{ type: 'text', text: out.text }], isError: false });
          break;
        }
        default:
          if (req.method?.startsWith('notifications/')) {
            break; // notifications get no response
          }
          fail(-32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      fail(-32603, err instanceof Error ? err.message : String(err));
    }
  });
  process.stderr.write(`librarian MCP server ready (root: ${root})\n`);
}
