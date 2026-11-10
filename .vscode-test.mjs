import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	// Core logic is covered by `pnpm test` (node:test); this runs inside the VS Code extension host.
	files: 'out/test/extension.test.js',
});
