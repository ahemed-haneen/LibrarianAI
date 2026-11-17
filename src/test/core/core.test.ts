import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, test } from 'node:test';
import { analyzeSource, resolveImport } from '../../core/analyzer';
import { logicalLines } from '../../core/pythonAnalyzer';
import { AGENT_FILE, INSTRUCTIONS_BLOCK, installCopilotInstructions, installLibrarianAgent, SKILLS } from '../../core/copilotInstructions';
import { IndexView } from '../../core/indexStore';
import { runIndex } from '../../core/indexer';
import { Librarian } from '../../core/librarian';
import { LlmClient } from '../../core/llm';
import { costHint } from '../../core/modelHints';
import { estimateSavings } from '../../core/savings';
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

describe('python support', () => {
  const sample = `"""Pay run endpoints.

Second paragraph mentioning def fake(): here.
"""
import os, logging
from fastapi import APIRouter, Depends
from app.models.payrun import PayRun, \\
    PayRunItem
from .schemas import (
    PayRunCreate,
    PayRunOut as Out,
)
from .. import deps

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/payruns")
PAGE_SIZE: int = 50
_private = 3


@router.post("/", response_model=Out)
async def create_payrun(
    body: PayRunCreate,
    db: Session = Depends(get_db),
    *,
    flag: bool = False,
) -> PayRun:
    """Create a pay run. More detail."""
    text = """
def not_real(): pass
"""
    from app.services import pay_service
    return pay_service.create(db, body)


def _helper(): ...


@dataclass(frozen=True)
class PayRunService(BaseService):
    """Business logic for pay runs."""
    __tablename__ = "payruns"
    id = Column(Integer, primary_key=True)
    name: str

    def __init__(self, db: Session, *, strict=False):
        self.db = db

    @property
    def total(self) -> int:
        return 1

    @total.setter
    def total(self, v): ...

    @staticmethod
    async def soft_delete(payrun_id: int) -> None:
        """Soft delete a pay run."""
        def inner(): ...

    def _internal(self): ...


if __name__ == "__main__":
    def main(): ...
`;

  test('extracts public surface, docstrings, decorators and class fields', () => {
    const a = analyzeSource('backend/app/api/payrun.py', sample);
    assert.match(a.skeleton, /^# module: Pay run endpoints\./);
    assert.match(a.skeleton, /@router\.post\("\/", response_model=Out\)/);
    assert.match(a.skeleton, /async def create_payrun\(body: PayRunCreate, db: Session = Depends\(get_db\), \*, flag: bool = False\) -> PayRun: \.\.\.  # Create a pay run\./);
    assert.match(a.skeleton, /router = APIRouter\(prefix="\/payruns"\)/);
    assert.match(a.skeleton, /PAGE_SIZE: int = 50/);
    assert.match(a.skeleton, /@dataclass\(frozen=True\)\nclass PayRunService\(BaseService\):  # Business logic for pay runs\./);
    assert.match(a.skeleton, /__tablename__ = "payruns"/);
    assert.match(a.skeleton, /id = Column\(Integer, primary_key=True\)/);
    assert.match(a.skeleton, / {4}def __init__\(db: Session, \*, strict = False\): \.\.\./);
    assert.match(a.skeleton, / {4}@property\n {4}def total\(\) -> int/);
    assert.match(a.skeleton, / {4}@staticmethod\n {4}async def soft_delete\(payrun_id: int\) -> None: \.\.\.  # Soft delete a pay run\./);
    // private names, bodies, nested functions, strings that look like code, and __main__ blocks stay out
    assert.doesNotMatch(a.skeleton, /_helper|_internal|_private|not_real|inner|main|logger|self\.db|return/);
    assert.strictEqual((a.skeleton.match(/def total/g) ?? []).length, 1, 'setter is not repeated');
    assert.deepStrictEqual(a.exportNames.sort(), ['PAGE_SIZE', 'PayRunService', 'create_payrun', 'router']);
  });

  test('collects absolute, relative and function-local imports', () => {
    const a = analyzeSource('backend/app/api/payrun.py', sample);
    for (const spec of ['py:os', 'py:app.models.payrun', 'py:app.models.payrun.PayRunItem', 'py:.schemas', 'py:.schemas.PayRunOut', 'py:..', 'py:..deps', 'py:app.services.pay_service']) {
      assert.ok(a.importSpecifiers.includes(spec), spec);
    }
  });

  test('imports resolve by package rules, nearest source root, and skip the standard library', () => {
    const known = new Set([
      'backend/app/__init__.py', 'backend/app/api/__init__.py', 'backend/app/api/payrun.py', 'backend/app/api/schemas.py',
      'backend/app/deps.py', 'backend/app/models/payrun.py', 'backend/app/logging.py',
      'svc2/app/models/payrun.py', 'svc2/app/main.py', 'web/src/x.ts',
    ]);
    const from = 'backend/app/api/payrun.py';
    assert.strictEqual(resolveImport(from, 'py:app.models.payrun', known), 'backend/app/models/payrun.py');
    assert.strictEqual(resolveImport('svc2/app/main.py', 'py:app.models.payrun', known), 'svc2/app/models/payrun.py', 'nearest root wins');
    assert.strictEqual(resolveImport(from, 'py:.schemas', known), 'backend/app/api/schemas.py');
    assert.strictEqual(resolveImport(from, 'py:..deps', known), 'backend/app/deps.py');
    assert.strictEqual(resolveImport(from, 'py:..', known), 'backend/app/__init__.py');
    assert.strictEqual(resolveImport(from, 'py:app.models.payrun.PayRun', known), undefined, 'a name, not a module');
    assert.strictEqual(resolveImport(from, 'py:logging', known), undefined, 'stdlib is never matched to repo files');
    assert.strictEqual(resolveImport(from, 'py:fastapi', known), undefined);
    assert.strictEqual(resolveImport(from, 'py:.....x', known), undefined);
  });

  test('package __init__.py re-exports are kept as its surface', () => {
    const a = analyzeSource('app/api/__init__.py', '"""API package."""\nfrom .payrun import router as payrun_router, create_payrun\n__all__ = ["extra"]\n');
    assert.match(a.skeleton, /from \.payrun import router as payrun_router, create_payrun/);
    assert.deepStrictEqual(a.exportNames.sort(), ['create_payrun', 'extra', 'payrun_router']);
  });

  test('logical lines handle continuations, comments and multi-line strings', () => {
    const lines = logicalLines('x = (1,\n  2)  # comment with "quote\ny = """a\nb"""\nz = 1 + \\\n  2\n');
    assert.deepStrictEqual(lines.map((l) => l.text), ['x = (1, 2)', 'y = """a b"""', 'z = 1 + 2']);
  });

  test('a mixed Python + TypeScript repo indexes, links and retrieves both', async () => {
    const root = tmpRepo({
      'backend/app/__init__.py': '',
      'backend/app/models/payrun.py': 'class PayRun:\n    """A pay run."""\n    __tablename__ = "payruns"\n    deleted_at = Column(DateTime)\n',
      'backend/app/services/payrun_service.py': 'from app.models.payrun import PayRun\n\ndef soft_delete_payrun(payrun_id: int) -> None:\n    """Soft delete a pay run."""\n    ...\n',
      'backend/app/api/billing.py': 'def create_invoice(client_id: int): ...\n',
      'web/src/ui.ts': 'export function renderTable(rows: string[]): string { return ""; }\n',
    });
    await runIndex({ root, layer: 'local' });
    const lib = new Librarian(root);
    assert.deepStrictEqual(lib.neighbours('backend/app/services/payrun_service.py'), ['backend/app/models/payrun.py']);
    const r = lib.findRelevant('add soft delete for pay runs');
    assert.strictEqual(r.files[0].path, 'backend/app/services/payrun_service.py');
    assert.ok(r.files.some((f) => f.path === 'backend/app/models/payrun.py'), 'import graph pulls in the model');
    assert.match(r.prompt, /```python\n/);
    assert.match(lib.getSkeletons(['backend/app/models/payrun.py']), /```python\nclass PayRun:/);
    assert.match(lib.status().text, /Source files: 5/);
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
    assert.ok(isSourcePath('backend/app/api/payrun.py'));
    assert.ok(!isSourcePath('backend/.venv/lib/x.py'));
    assert.ok(!isSourcePath('venv/lib/site-packages/x.py'));
    assert.ok(!isSourcePath('backend/app/pb/thing_pb2.py'));
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

  test('agent and skills replace the retired chat participant', () => {
    const root = tmpRepo({ 'a.ts': 'export const a = 1;' });
    const first = installLibrarianAgent(root);
    assert.strictEqual(first.created, 1 + SKILLS.length);
    assert.strictEqual(fs.readFileSync(path.join(root, '.github/agents/librarian.agent.md'), 'utf8'), AGENT_FILE);
    for (const s of SKILLS) {
      const text = fs.readFileSync(path.join(root, '.github/skills', s.name, 'SKILL.md'), 'utf8');
      assert.match(text, /disable-model-invocation: true/);
    }
    assert.deepStrictEqual(installLibrarianAgent(root).files, []);
    const own = path.join(root, '.github/agents/librarian.agent.md');
    fs.writeFileSync(own, '---\nname: Mine\n---\nmy own agent\n');
    assert.deepStrictEqual(installLibrarianAgent(root).files, []);
    assert.match(fs.readFileSync(own, 'utf8'), /my own agent/);
  });

  test('no chat participant is contributed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
    assert.strictEqual(pkg.contributes.chatParticipants, undefined);
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

describe('model cost hints', () => {
  test('flags cheap and premium families, never guesses confidently otherwise', () => {
    for (const f of ['gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'gpt-5-mini', 'claude-haiku-4.5', 'gemini-2.0-flash', 'o3-mini']) {
      assert.strictEqual(costHint(f), 'low', f);
    }
    for (const f of ['gpt-5', 'gpt-5.1', 'claude-sonnet-4.5', 'claude-opus-4.1', 'o3', 'gemini-2.5-pro']) {
      assert.strictEqual(costHint(f), 'premium', f);
    }
    assert.strictEqual(costHint('some-new-model'), 'unknown');
  });
});

describe('savings estimate', () => {
  test('replays git history leave-one-out and reports savings and recall', async () => {
    const filler = (name: string) =>
      Array.from({ length: 60 }, (_, i) => `function ${name}Helper${i}(x: number): number { return x * ${i} + ${i}; }`).join('\n');
    const root = tmpRepo({
      'src/billing/invoice.ts': `import { computeVat } from './tax';\n/** Builds invoices for customers. */\nexport function createInvoice(customerId: string): Invoice { return {} as Invoice; }\n${filler('inv')}`,
      'src/billing/tax.ts': `/** VAT and sales tax rules. */\nexport function computeVat(amount: number, country: string): number { return amount; }\n${filler('tax')}`,
      'src/http/routes.ts': `import { createInvoice } from '../billing/invoice';\nexport function registerRoutes(app: App): void {}\n${filler('routes')}`,
      'src/ui/button.ts': `export function Button(label: string): Element { return null as any; }\n${filler('btn')}`,
      'src/ui/theme.ts': `export const theme = { primary: 'blue' };\n${filler('theme')}`,
    });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'initial import');
    fs.appendFileSync(path.join(root, 'src/billing/tax.ts'), '\nexport const EU_VAT = 0.2;');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'Add EU VAT rate to tax computation');
    fs.appendFileSync(path.join(root, 'src/ui/button.ts'), '\nexport const BUTTON_SIZE = 3;');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'Make the button bigger');

    await runIndex({ root, layer: 'local' });
    const lib = new Librarian(root);
    const before = lib.view.layers.local.stats().promptsBuilt;
    const r = await estimateSavings(lib, { commits: 10, costPerMillionTokens: 3 });

    assert.ok(r.cases.length >= 2, `cases: ${r.cases.length}`);
    const vat = r.cases.find((c) => c.task.includes('EU VAT'))!;
    assert.deepStrictEqual(vat.found, ['src/billing/tax.ts']);
    assert.ok(vat.withLibrarian < vat.without, 'pack is cheaper than exploring neighbours');
    assert.ok(r.totals.recall > 0);
    assert.match(r.markdown, /Context tokens per task/);
    assert.match(r.markdown, /per 1,000 tasks/);
    assert.match(r.markdown, /How this is calculated/);
    assert.strictEqual(lib.view.layers.local.stats().promptsBuilt, before, 'estimates do not pollute usage stats');
  });
});

describe('savings diagnostics', () => {
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
  const filler = (name: string) => Array.from({ length: 40 }, (_, i) => `def ${name}_helper_${i}(x: int) -> int:\n    return x * ${i}`).join('\n');

  test('explains skipped commits, missed files and why tasks did not save', async () => {
    const root = tmpRepo({
      'backend/app/services/payrun_service.py': `from app.models.payrun import PayRun\n\ndef create_payrun(db, body):\n    """Create a pay run."""\n    return PayRun()\n${filler('svc')}`,
      'backend/app/models/payrun.py': `class PayRun:\n    """A pay run."""\n    __tablename__ = "payruns"\n${filler('model')}`,
      'web/ui.ts': 'export function renderTable(rows: string[]): string { return ""; }\n',
      'db/001.sql': 'select 1;\n',
    });
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial import');
    fs.appendFileSync(path.join(root, 'db/001.sql'), 'select 2;\n');
    git(root, 'commit', '-qam', 'PYPAY-1 migration');
    fs.appendFileSync(path.join(root, 'backend/app/services/payrun_service.py'), '\ndef soft_delete_payrun(db, payrun_id: int):\n    """Soft delete a pay run."""\n');
    fs.appendFileSync(path.join(root, 'backend/app/models/payrun.py'), '    deleted_at = Column(DateTime)\n');
    fs.writeFileSync(path.join(root, 'db/002.sql'), 'select 3;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'Add soft delete for pay runs');
    fs.appendFileSync(path.join(root, 'web/ui.ts'), '// z\n');
    git(root, 'commit', '-qam', 'PYPAY-2');

    await runIndex({ root, layer: 'local' });
    const r = await estimateSavings(new Librarian(root), { commits: 10 });
    const d = r.diagnostics;

    // skipped commits are explained, with the file types that caused it
    const noSource = d.skipped.find((k) => k.reason === 'no-source-files')!;
    assert.strictEqual(noSource.commits, 1);
    assert.deepStrictEqual(d.skippedExtensions, { '.sql': 1 });
    assert.strictEqual(d.unindexedChangedExtensions['.sql'], 2, '.sql files changed next to indexed files (initial import, soft delete)');
    assert.ok(d.suggestions.some((x) => /\.sql/.test(x) && /do(es)? not index|indexes/.test(x)));

    // every replayed task has exactly one cause, and the totals add up
    assert.strictEqual(Object.values(d.causes).reduce((a, c) => a + c.tasks, 0), r.cases.length);
    assert.strictEqual(Object.values(d.causes).reduce((a, c) => a + c.netTokens, 0), r.totals.saved);
    r.cases.forEach((c) => assert.ok(['saved', 'retrieval-misses', 'pack-larger-than-exploration', 'nothing-to-explore'].includes(c.cause)));

    // a ticket-id-only message is flagged and its misses are blamed on the wording
    const vague = r.cases.find((c) => c.task === 'PYPAY-2')!;
    assert.strictEqual(vague.vague, true);
    assert.strictEqual(vague.found.length, 0);
    assert.deepStrictEqual(vague.missed.map((m) => m.reason), ['vague-task']);
    assert.strictEqual(d.missesByReason['vague-task'] >= 1, true);
    assert.strictEqual(d.totalMisses, Object.values(d.missesByReason).reduce((a, b) => a + b, 0));

    // the ceiling is never below the actual result: perfect retrieval cannot do worse
    assert.ok(d.ceilingSavedPct >= d.actualSavedPct - 1e-9);

    // the report explains itself and carries a parseable JSON copy
    assert.match(r.markdown, /## Why savings were limited/);
    assert.match(r.markdown, /### Commits left out of the replay/);
    assert.match(r.markdown, /### What to do about it/);
    const json = /```json\n([\s\S]*?)\n```/.exec(r.markdown)![1];
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.tasks.length, r.cases.length);
    assert.strictEqual(parsed.diagnostics.totalMisses, d.totalMisses);
  });

  test('says why when nothing could be replayed', async () => {
    const root = tmpRepo({ 'a.ts': 'export const a = 1;\n', 'db/1.sql': 'select 1;\n' });
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial');
    fs.appendFileSync(path.join(root, 'db/1.sql'), 'select 2;\n');
    git(root, 'commit', '-qam', 'tweak sql');
    await runIndex({ root, layer: 'local' });
    const r = await estimateSavings(new Librarian(root), { commits: 1 });
    assert.strictEqual(r.cases.length, 0);
    assert.match(r.markdown, /No replayable tasks yet/);
    assert.match(r.markdown, /Why nothing could be replayed/);
    assert.match(r.markdown, /Changed no file type Librarian indexes/);
  });
});

describe('saved notes (chat context memory)', () => {
  test('save, update by title, search, and stay out of task memory', async () => {
    const root = tmpRepo({
      'src/auth/login.ts': `export function login(user: string, password: string): Promise<Session> { return null as any; }`,
      'src/auth/rateLimit.ts': `export function limit(key: string): boolean { return true; }`,
      'src/ui/button.ts': `export function Button(label: string): Element { return null as any; }`,
    });
    await runIndex({ root, layer: 'local' });
    const lib = new Librarian(root);

    const saveTool = TOOL_DEFS.find((t) => t.name === 'librarian_saveNote')!;
    const out = saveTool.run(lib, {
      title: 'Login rate limiting',
      summary: 'Decided: 5 attempts per minute per IP using a sliding window in rateLimit.ts. Return 429 with Retry-After. Redis rejected (no infra).',
      files: ['src/auth/rateLimit.ts', './src/auth/login.ts'],
    });
    assert.match(out.text, /Saved note "Login rate limiting"/);
    assert.ok(saveTool.confirm, 'write tool asks for confirmation');

    // Same title updates instead of duplicating.
    lib.notes.save({ title: 'login rate limiting', summary: 'Update: limit raised to 10 attempts per minute.', source: 'chat' });
    assert.strictEqual(lib.notes.all().length, 1);
    assert.match(lib.notes.all()[0].note.summary, /10 attempts/);
    assert.deepStrictEqual(lib.notes.all()[0].note.files, ['src/auth/rateLimit.ts', 'src/auth/login.ts']);

    // Notes are knowledge, not edits.
    assert.strictEqual(lib.memory.all().length, 0);
    assert.ok(!fs.existsSync(path.join(root, '.trishAI/shared/notes.json')), 'personal notes stay in the git-ignored layer');

    // Reused automatically in a related task, with its files boosted.
    const pack = lib.findRelevant('tweak the login attempt limit');
    assert.match(pack.prompt, /## Saved context from earlier chats/);
    assert.match(pack.prompt, /10 attempts per minute/);
    assert.ok(pack.files.some((f) => f.path === 'src/auth/rateLimit.ts' && f.reasons.some((r) => r.includes('saved note'))));

    // Unrelated task: no note.
    assert.doesNotMatch(lib.findRelevant('make the button blue').prompt, /Saved context/);

    // Recall tool and sharing.
    const recall = TOOL_DEFS.find((t) => t.name === 'librarian_recallNotes')!.run(lib, { query: 'what did we decide about rate limiting' });
    assert.match(recall.text, /Login rate limiting/);
    const id = lib.notes.all()[0].note.id;
    assert.ok(lib.notes.share(id));
    assert.strictEqual(lib.notes.all()[0].layer, 'shared');
    assert.ok(lib.notes.remove(id));
    assert.strictEqual(lib.notes.all().length, 0);
  });

  test('notes can be switched off', async () => {
    const root = tmpRepo({ 'src/a.ts': `export function payInvoice(id: string): void {}` });
    await runIndex({ root, layer: 'local' });
    new Librarian(root).notes.save({ title: 'Invoice payments', summary: 'Use the ledger API for invoice payments.' });
    assert.doesNotMatch(new Librarian(root, 'onApiChange', false).findRelevant('pay invoice').prompt, /Saved context/);
    assert.match(new Librarian(root).findRelevant('pay invoice').prompt, /ledger API/);
  });
});
