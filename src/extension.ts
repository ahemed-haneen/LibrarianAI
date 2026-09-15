import * as vscode from 'vscode';
import * as fs from 'fs';
import { CoverageNode, CoverageTreeProvider } from './coverageTreeProvider';
import { AstGenerator } from './astGenerator';
import { LibrarianPanel } from './librarianPanel';

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

    const runGenerateSkeleton = async (node: CoverageNode) => {
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
    };

    const generateSkeletonCmd = vscode.commands.registerCommand('trishAI.generateSkeleton', runGenerateSkeleton);
    const updateSkeletonCmd = vscode.commands.registerCommand('trishAI.updateSkeleton', runGenerateSkeleton);

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