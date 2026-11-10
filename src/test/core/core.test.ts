import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { analyzeSource, resolveImport } from '../../core/analyzer';
import { INSTRUCTIONS_BLOCK, installCopilotInstructions } from '../../core/copilotInstructions';
import { IndexView } from '../../core/indexStore';
import { runIndex } from '../../core/indexer';
import { Librarian } from '../../core/librarian';
import { LlmClient } from '../../core/llm';
import { isSourcePath } from '../../core/sourceFiles';
import { TOOL_DEFS } from '../../core/tools';
import { tokenize } from '../../core/util';

class FakeLlm implements LlmClient {
  label = 'fake';
  calls: string[] = [];
  async complete(prompt: string): Promise<string> {
    const file = /File: (\S+)/.exec(prompt)?.[1] ?? '?';
    this.calls.push(file);
    return `**Summary** — summary of ${file}`;
  }
}

function tmpRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'librarian-test-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

describe('analyzer', () => {
  test('extracts exports, docs and skips private members and bodies', () => {
    const a = analyzeSource('a.ts', `
      import { x } from './x';
      /** Handles user sessions. More detail here. */
      export class SessionStore extends Base {
        private secret = 1;
        #hidden = 2;
        constructor(private db: Db) { super(); }
        async load(id: string): Promise<Session> { return this.db.get(id); }
        get size(): number { return 0; }
      }
      export const makeToken = async (userId: string, ttl = 60): Promise<string> => 'x';
      export default function handler(req: Req) {}
      export { a as b } from './c';
      export * from './d';
      const notExported = 1;
    `);
    assert.match(a.skeleton, /\/\*\* Handles user sessions\. \*\//);
    assert.match(a.skeleton, /export class SessionStore extends Base \{/);
    assert.match(a.skeleton, /async load\(id: string\): Promise<Session>;/);
    assert.match(a.skeleton, /get size\(\): number;/);
    assert.doesNotMatch(a.skeleton, /secret|hidden|notExported|this\.db/);
    assert.match(a.skeleton, /export const makeToken: async \(userId: string, ttl\?\) => Promise<string>;/);
    assert.match(a.skeleton, /export default function handler\(req: Req\);/);
    assert.match(a.skeleton, /export \{ a as b \} from '\.\/c';/);
    assert.match(a.skeleton, /export \* from '\.\/d';/);
    assert.deepStrictEqual(a.importSpecifiers.sort(), ['./c', './d', './x']);
    assert.ok(a.exportNames.includes('SessionStore') && a.exportNames.includes('b') && a.exportNames.includes('default'));
  });

  test('handles CommonJS and require()', () => {
    const a = analyzeSource('lib.js', `
      const util = require('./util');
      function add(a, b) { return a + b; }
      module.exports = { add, sub: (a, b) => a - b };
      exports.version = '1.0';
    `);
    assert.match(a.skeleton, /module\.exports = \{ add; sub \};/);
    assert.match(a.skeleton, /exports\.version: '1\.0';/);
    assert.ok(a.exportNames.includes('add') && a.exportNames.includes('version'));
    assert.deepStrictEqual(a.importSpecifiers, ['./util']);
  });

  test('resolves extensionless, index and Node16 .js specifiers', () => {
    const known = new Set(['src/a.ts', 'src/lib/index.ts', 'src/b.tsx']);
    assert.strictEqual(resolveImport('src/c.ts', './a.js', known), 'src/a.ts');
    assert.strictEqual(resolveImport('src/c.ts', './lib', known), 'src/lib/index.ts');
    assert.strictEqual(resolveImport('src/x/c.ts', '../b', known), 'src/b.tsx');
    assert.strictEqual(resolveImport('src/c.ts', 'react', known), undefined);
  });
});

describe('source filter', () => {
  test('one rule for every component', () => {
    assert.ok(isSourcePath('src/a.ts'));
    assert.ok(isSourcePath('lib/b.mjs'));
    assert.ok(!isSourcePath('src/types.d.ts'));
    assert.ok(!isSourcePath('node_modules/x/index.js'));
    assert.ok(!isSourcePath('.trishAI/shared/files/a.ts'));
    assert.ok(!isSourcePath('dist/extension.js'));
    assert.ok(!isSourcePath('README.md'));
  });

  test('tokenize splits identifiers and stems', () => {
    assert.deepStrictEqual(tokenize('getUserSessions rate_limiting'), ['user', 'session', 'rate', 'limit']);
  });
});

describe('incremental indexer', () => {
  test('only pays for summaries when the public API changes', async () => {
    const root = tmpRepo({
      'src/auth.ts': `export function login(user: string): boolean { return true; }`,
      'src/math.ts': `import { login } from './auth';\nexport const add = (a: number, b: number): number => a + b;`,
    });
    const llm = new FakeLlm();

    const r1 = await runIndex({ root, layer: 'shared', llm });
    assert.strictEqual(r1.skeletonsWritten, 2);
    assert.strictEqual(llm.calls.length, 2);

    const r2 = await runIndex({ root, layer: 'shared', llm });
    assert.strictEqual(r2.skeletonsUnchanged, 2);
    assert.strictEqual(llm.calls.length, 2, 'unchanged files cost nothing');

    // Implementation-only change: skeleton refreshed for free, summary kept.
    fs.writeFileSync(path.join(root, 'src/auth.ts'), `export function login(user: string): boolean { return user.length > 0; }`);
    const r3 = await runIndex({ root, layer: 'shared', llm });
    assert.strictEqual(r3.skeletonsWritten, 1);
    assert.strictEqual(r3.contextsReused, 2);
    assert.strictEqual(llm.calls.length, 2);

    // API change: one new summary.
    fs.writeFileSync(path.join(root, 'src/auth.ts'), `export function login(user: string, otp: string): boolean { return true; }`);
    await runIndex({ root, layer: 'shared', llm });
    assert.deepStrictEqual(llm.calls.slice(2), ['src/auth.ts']);

    // Import graph recorded.
    const view = new IndexView(root);
    assert.deepStrictEqual(view.resolve('src/math.ts')!.record.imports, ['src/auth.ts']);

    // Deleted files are pruned.
    fs.rmSync(path.join(root, 'src/math.ts'));
    const r5 = await runIndex({ root, layer: 'shared' });
    assert.strictEqual(r5.removed, 1);
  });

  test('local layer reuses a fresh shared (CI) index without any work', async () => {
    const root = tmpRepo({ 'src/a.ts': `export const a = 1;`, 'src/b.ts': `export const b = 2;` });
    const llm = new FakeLlm();
    await runIndex({ root, layer: 'shared', llm });
    const local = await runIndex({ root, layer: 'local', llm });
    assert.strictEqual(local.skeletonsWritten, 0);
    assert.strictEqual(local.contextsReused, 2);
    assert.strictEqual(llm.calls.length, 2);

    // A local edit goes to the overlay only.
    fs.writeFileSync(path.join(root, 'src/a.ts'), `export const a = 1;\nexport const a2 = 3;`);
    await runIndex({ root, layer: 'local', files: ['src/a.ts'] });
    const view = new IndexView(root);
    const e = view.resolve('src/a.ts', undefined)!;
    assert.ok(view.layers.local.get('src/a.ts'));
    assert.match(view.readSkeleton(e)!, /a2/);
    assert.ok(fs.readFileSync(path.join(root, '.trishAI/.gitignore'), 'utf8').includes('local/'));
  });

  test('cancellation stops summary calls', async () => {
    const root = tmpRepo(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`src/f${i}.ts`, `export const v${i} = ${i};`])));
    const llm = new FakeLlm();
    const ac = new AbortController();
    const slow: LlmClient = {
      label: 'slow',
      complete: async (p) => {
        ac.abort();
        return llm.complete(p);
      },
    };
    const r = await runIndex({ root, layer: 'shared', llm: slow, concurrency: 1, signal: ac.signal });
    assert.ok(r.cancelled);
    assert.strictEqual(llm.calls.length, 1);
  });
});

describe('retrieval and memory', () => {
  test('past edits teach the ranking', async () => {
    const root = tmpRepo({
      'src/billing/invoice.ts': `export function createInvoice(customerId: string): Invoice { return {} as Invoice; }`,
      'src/billing/tax.ts': `export function computeVat(amount: number): number { return amount; }`,
      'src/http/routes.ts': `import { createInvoice } from '../billing/invoice';\nexport function registerRoutes(app: App): void {}`,
      'src/ui/button.ts': `export function Button(label: string): Element { return null as any; }`,
    });
    await runIndex({ root, layer: 'local' });
    const lib = new Librarian(root);

    const first = lib.findRelevant('add VAT to invoices for EU customers', { remember: true });
    assert.ok(first.files.some((f) => f.path === 'src/billing/invoice.ts'));
    assert.ok(first.files.some((f) => f.path === 'src/http/routes.ts' && f.role === 'related'), 'graph expansion adds importers');

    // Developer actually edited routes.ts and button.ts for that task.
    lib.memory.touch(first.taskId!, 'src/ui/button.ts');

    const again = new Librarian(root).findRelevant('show VAT on invoices for EU customers');
    const button = again.files.find((f) => f.path === 'src/ui/button.ts');
    assert.ok(button, 'file changed in a similar task is now suggested');
    assert.ok(button!.reasons.some((r) => r.includes('similar task')));
    assert.ok(again.deliveredTokens > 0 && again.prompt.includes('## Task'));
  });

  test('budget keeps packs small', async () => {
    const big = Array.from({ length: 80 }, (_, i) => `export function handler${i}(input: RequestPayload${i}): ResponsePayload${i} { return null as any; }`).join('\n');
    const root = tmpRepo({ 'src/a.ts': big, 'src/b.ts': big.replace(/handler/g, 'worker') });
    await runIndex({ root, layer: 'local' });
    const r = new Librarian(root).findRelevant('handler worker payload', { budget: 1500 });
    assert.ok(r.deliveredTokens <= 1700, `delivered ${r.deliveredTokens}`);
    assert.match(r.prompt, /Also relevant/);
  });
});

describe('copilot instructions', () => {
  test('install is idempotent and keeps user content', () => {
    const root = tmpRepo({ '.github/copilot-instructions.md': '# Ours\nUse tabs.\n' });
    assert.strictEqual(installCopilotInstructions(root).action, 'updated');
    assert.strictEqual(installCopilotInstructions(root).action, 'unchanged');
    const text = fs.readFileSync(path.join(root, '.github/copilot-instructions.md'), 'utf8');
    assert.ok(text.startsWith('# Ours\nUse tabs.'));
    assert.strictEqual(text.match(/librarian:start/g)!.length, 1);
  });
});

describe('package.json contributions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
  const extensionSrc = fs.readFileSync(path.join(__dirname, '../../../src/extension.ts'), 'utf8');

  test('Copilot tools match the shared tool contract', () => {
    const contributed = pkg.contributes.languageModelTools as { name: string; inputSchema: unknown; modelDescription: string }[];
    assert.deepStrictEqual(contributed.map((t) => t.name), TOOL_DEFS.map((t) => t.name));
    for (const def of TOOL_DEFS) {
      const c = contributed.find((t) => t.name === def.name)!;
      assert.deepStrictEqual(c.inputSchema, def.inputSchema, `${def.name} schema`);
      assert.strictEqual(c.modelDescription, def.description, `${def.name} description`);
    }
  });

  test('every contributed and menu command is registered', () => {
    const declared = new Set((pkg.contributes.commands as { command: string }[]).map((c) => c.command));
    const menus = Object.values(pkg.contributes.menus as Record<string, { command: string }[]>).flat().map((m) => m.command);
    menus.forEach((m) => assert.ok(declared.has(m), `menu command ${m} declared`));
    declared.forEach((c) => assert.ok(extensionSrc.includes(`'${c}'`), `command ${c} registered in extension.ts`));
  });

  test('copilot instructions reference real tool names', () => {
    for (const t of pkg.contributes.languageModelTools as { toolReferenceName: string }[]) {
      assert.ok(INSTRUCTIONS_BLOCK.includes(`#${t.toolReferenceName}`), t.toolReferenceName);
    }
  });
});
