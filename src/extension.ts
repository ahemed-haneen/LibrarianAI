import * as vscode from 'vscode';
import * as fs from 'fs';
import { CoverageNode, CoverageTreeProvider } from './coverageTreeProvider';
import { AstGenerator } from './astGenerator';
import { ContextGenerator, AIProvider } from './contextGenerator';
import { LibrarianPanel } from './librarianPanel';

function buildContextGenerator(): { generator: ContextGenerator; label: string } | { generator: null; reason: string } {
    const cfg = vscode.workspace.getConfiguration('trishAI');
    const provider = (cfg.get<string>('aiProvider') || 'copilot') as AIProvider;

    if (provider === 'anthropic') {
        const apiKey = (cfg.get<string>('anthropicApiKey') || '').trim();
        if (!apiKey) {
            return {
                generator: null,
                reason: 'No Anthropic API key set. Add it under Settings → TrishAI → Anthropic Api Key, or switch the provider to "copilot".',
            };
        }
        const model = (cfg.get<string>('anthropicModel') || 'claude-haiku-4-5-20251001').trim();
        return {
            generator: new ContextGenerator({ provider: 'anthropic', anthropicApiKey: apiKey, anthropicModel: model }),
            label: `Anthropic / ${model}`,
        };
    }

    // copilot — no pre-flight check needed; errors surface at call time
    const family = (cfg.get<string>('copilotModel') || '').trim();
    return {
        generator: new ContextGenerator({ provider: 'copilot', copilotModelFamily: family }),
        label: family ? `Copilot / ${family}` : 'Copilot (auto)',
    };
}

export function activate(context: vscode.ExtensionContext) {
    const rootPath =
        vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined;

    const coverageTreeProvider = new CoverageTreeProvider(rootPath);
    vscode.window.registerTreeDataProvider('trishAICoverageView', coverageTreeProvider);

    const helloWorldCmd = vscode.commands.registerCommand('trinet-ai-smart-assist.helloWorld', () => {
        vscode.window.showInformationMessage('trishAI is online!');
    });

    const refreshCmd = vscode.commands.registerCommand('trishAICoverageView.refresh', () => {
        coverageTreeProvider.refresh();
    });

    const runGenerate = async (node: CoverageNode) => {
        if (!rootPath || !node.fsPath) {
            vscode.window.showWarningMessage('No folder or file selected.');
            return;
        }

        const result = buildContextGenerator();
        const isFile = fs.statSync(node.fsPath).isFile();

        if (!result.generator) {
            // Skeleton still works without AI — generate it then warn about context
            if (isFile) {
                AstGenerator.generateForFile(rootPath, node.fsPath);
            } else {
                AstGenerator.generateForFolder(rootPath, node.fsPath);
            }
            coverageTreeProvider.refresh();
            vscode.window.showWarningMessage(
                `Skeleton generated. Context skipped: ${result.reason}`,
                'Open Settings'
            ).then((choice) => {
                if (choice === 'Open Settings') {
                    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:trinet-ai-smart-assist');
                }
            });
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: isFile
                    ? `TrishAI: generating skeleton & context for "${node.label}"…`
                    : `TrishAI: generating skeleton & context for folder "${node.label}"…`,
                cancellable: false,
            },
            async () => {
                try {
                    if (isFile) {
                        AstGenerator.generateForFile(rootPath, node.fsPath!);
                        await result.generator!.generateForFile(rootPath, node.fsPath!);
                        vscode.window.showInformationMessage(
                            `Skeleton + context generated for "${node.label}" via ${result.label}`
                        );
                    } else {
                        const skeletonCount = AstGenerator.generateForFolder(rootPath, node.fsPath!);
                        const contextCount = await result.generator!.generateForFolder(rootPath, node.fsPath!);
                        vscode.window.showInformationMessage(
                            `Generated ${skeletonCount} skeleton(s) + ${contextCount} context file(s) for "${node.label}" via ${result.label}`
                        );
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Context generation failed: ${msg}`, 'Open Settings').then((choice) => {
                        if (choice === 'Open Settings') {
                            vscode.commands.executeCommand('workbench.action.openSettings', '@ext:trinet-ai-smart-assist');
                        }
                    });
                }

                coverageTreeProvider.refresh();
            }
        );
    };

    const generateSkeletonCmd = vscode.commands.registerCommand('trishAI.generateSkeleton', runGenerate);
    const updateSkeletonCmd = vscode.commands.registerCommand('trishAI.updateSkeleton', runGenerate);

    const askLibrarianCmd = vscode.commands.registerCommand('trishAI.askLibrarian', () => {
        if (!rootPath) {
            vscode.window.showWarningMessage('No workspace folder open.');
            return;
        }
        LibrarianPanel.show(context, rootPath);
    });

    context.subscriptions.push(helloWorldCmd, refreshCmd, generateSkeletonCmd, updateSkeletonCmd, askLibrarianCmd);
}

export function deactivate() {}
