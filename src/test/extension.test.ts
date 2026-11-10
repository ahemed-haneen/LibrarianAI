import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Librarian extension', () => {
	test('activates and registers commands and Copilot tools', async () => {
		const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'trinet-ai-smart-assist');
		assert.ok(ext, 'extension found');
		await ext!.activate();

		const commands = await vscode.commands.getCommands(true);
		for (const c of ['trishAI.indexWorkspace', 'trishAI.askLibrarian', 'trishAI.installCopilotInstructions', 'trishAI.showFeatures']) {
			assert.ok(commands.includes(c), `command ${c}`);
		}
		const tools = vscode.lm.tools.map((t) => t.name);
		for (const t of ['librarian_findRelevantFiles', 'librarian_getSkeleton', 'librarian_getRelatedFiles']) {
			assert.ok(tools.includes(t), `tool ${t}`);
		}
	});
});
