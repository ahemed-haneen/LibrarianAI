import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

export class AstGenerator {
  static generateForFolder(rootPath: string, folderPath: string): number {
    let generatedCount = 0;
    try {
      const entries = fs.readdirSync(folderPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(folderPath, entry.name);

        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'build', '.git', '.vscode', '.trishAI'].includes(entry.name)) {
            generatedCount += this.generateForFolder(rootPath, fullPath);
          }
        } else if (
          entry.isFile() &&
          /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
          !entry.name.endsWith('.d.ts')
        ) {
          this.generateForFile(rootPath, fullPath);
          generatedCount++;
        }
      }
    } catch (err) {
      console.error(`Error generating AST for ${folderPath}:`, err);
    }
    return generatedCount;
  }

  static generateForFile(rootPath: string, filePath: string): void {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      path.basename(filePath),
      fileContent,
      ts.ScriptTarget.Latest,
      true
    );

    const relativePath = path.relative(rootPath, filePath);
    const targetDir = path.join(rootPath, '.trishAI', path.dirname(relativePath));
    const targetFile = path.join(targetDir, `${path.basename(filePath)}.skeleton.md`);

    fs.mkdirSync(targetDir, { recursive: true });

    const signatures: string[] = [
      `# Skeleton: \`${relativePath}\``,
      `*Generated: ${new Date().toISOString()}*\n`,
      '```typescript'
    ];

    ts.forEachChild(sourceFile, (node) => {
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      const isExported = modifiers?.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.ExportKeyword);

      if (isExported) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const name = node.name.text;
          const params = node.parameters.map((p) => p.getText(sourceFile)).join(', ');
          const returnType = node.type ? node.type.getText(sourceFile) : 'any';
          signatures.push(`export function ${name}(${params}): ${returnType};`);
        } else if (ts.isInterfaceDeclaration(node)) {
          signatures.push(`export interface ${node.name.text} {`);
          node.members.forEach((m) => signatures.push(`  ${m.getText(sourceFile)};`));
          signatures.push('}');
        } else if (ts.isTypeAliasDeclaration(node)) {
          signatures.push(`export type ${node.name.text} = ${node.type.getText(sourceFile)};`);
        } else if (ts.isEnumDeclaration(node)) {
          signatures.push(`export enum ${node.name.text} {`);
          node.members.forEach((m) => signatures.push(`  ${m.getText(sourceFile)},`));
          signatures.push('}');
        } else if (ts.isClassDeclaration(node) && node.name) {
          signatures.push(`export class ${node.name.text} {`);
          node.members.forEach((m) => {
            if (ts.isMethodDeclaration(m) && m.name) {
              const name = m.name.getText(sourceFile);
              const params = m.parameters.map((p) => p.getText(sourceFile)).join(', ');
              const ret = m.type ? m.type.getText(sourceFile) : 'void';
              signatures.push(`  ${name}(${params}): ${ret};`);
            } else if (ts.isPropertyDeclaration(m) && m.name) {
              signatures.push(`  ${m.name.getText(sourceFile)}: ${m.type ? m.type.getText(sourceFile) : 'any'};`);
            }
          });
          signatures.push('}');
        } else if (ts.isVariableStatement(node)) {
          node.declarationList.declarations.forEach((decl) => {
            if (ts.isIdentifier(decl.name)) {
              const type = decl.type ? decl.type.getText(sourceFile) : 'any';
              signatures.push(`export const ${decl.name.text}: ${type};`);
            }
          });
        }
      }
    });

    signatures.push('```\n');
    fs.writeFileSync(targetFile, signatures.join('\n'));
  }
}