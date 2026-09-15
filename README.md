# TrishAI — VS Code Extension

A VS Code extension that helps TriNet employees work more productively with AI tools by generating and tracking **AST skeleton files** for their TypeScript/JavaScript codebase. The goal is to feed AI agents a compact, structured representation of a codebase's public API rather than full source files — reducing token costs while keeping context meaningful.

## What it does

### Codebase AI Coverage Tracker
A sidebar tree view (activity bar) shows every `.ts/.tsx/.js/.jsx` file in your workspace and whether it has been **indexed** (i.e., has a generated skeleton). The root of the tree displays an **AI Readiness** percentage — the share of files that have been mapped — with a colour-coded icon (green > 75%, yellow > 25%, orange otherwise).

### AST Skeleton Generation
Right-clicking any file or folder in the tree and selecting **Generate AST Skeleton** (⚡) triggers `AstGenerator`, which:

1. Parses the file(s) with the TypeScript compiler API (`ts.createSourceFile`).
2. Walks the top-level AST and extracts only **exported** declarations:
   - Functions → `export function name(params): returnType;`
   - Classes → class shell with method and property signatures
   - Interfaces → full member list
   - Type aliases → `export type Name = ...;`
3. Writes a `.skeleton.md` file into a `.trishAI/` mirror directory inside the workspace root (e.g. `src/foo.ts` → `.trishAI/src/foo.ts.skeleton.md`).

The skeletons are lightweight markdown code blocks — just the public contract of each file, with no implementation details.

## Project structure

```
src/
  extension.ts           — activation, command registration
  astGenerator.ts        — TypeScript AST parsing & skeleton file writer
  coverageTreeProvider.ts — VS Code TreeDataProvider for the sidebar view
```

## Commands

| Command | Description |
|---|---|
| `trishAI.generateSkeleton` | Generate AST skeleton for a file or folder |
| `trishAICoverageView.refresh` | Re-scan the workspace and refresh the tree |
| `trinet-ai-smart-assist.helloWorld` | Smoke-test command |

## Output format

Skeletons are stored under `.trishAI/` at the workspace root (excluded from the tree view itself). Each file looks like:

```markdown
# Skeleton: `src/myModule.ts`
*Generated: 2025-01-01T00:00:00.000Z*

\`\`\`typescript
export function doThing(input: string): boolean;
export class MyService {
  someMethod(id: number): Promise<void>;
  name: string;
}
export interface Config {
  timeout: number;
  retries: number;
}
\`\`\`
```

## Development

```bash
pnpm install
pnpm run compile   # type-check + lint + bundle
pnpm run watch     # watch mode (esbuild + tsc)
pnpm test          # run extension tests
```

Requires VS Code `^1.134.0`. Built with TypeScript 6, bundled with esbuild.
