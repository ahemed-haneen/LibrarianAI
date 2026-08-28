import * as vscode from 'vscode';
import * as fs from 'fs';
import { CoverageNode, CoverageTreeProvider } from './coverageTreeProvider';
import { AstGenerator } from './astGenerator';

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

    const generateSkeletonCmd = vscode.commands.registerCommand('trishAI.generateSkeleton', async (node: CoverageNode) => {
        if (!rootPath || !node.fsPath) {
            vscode.window.showWarningMessage('No folder or file selected.');
            return;
        }

        const isFile = fs.statSync(node.fsPath).isFile();

        if (isFile) {
            AstGenerator.generateForFile(rootPath, node.fsPath);
            vscode.window.showInformationMessage(`Generated AST skeleton for "${node.label}" in .trishAI`);
        } else {
            const count = AstGenerator.generateForFolder(rootPath, node.fsPath);
            vscode.window.showInformationMessage(`Generated ${count} AST skeleton file(s) for "${node.label}" in .trishAI`);
        }

        coverageTreeProvider.refresh();
    });

    context.subscriptions.push(helloWorldCmd, refreshCmd, generateSkeletonCmd);
}

export function deactivate() {}