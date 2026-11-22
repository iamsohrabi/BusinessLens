import * as path from "node:path";
import * as vscode from "vscode";
import { ScannedSourceFile } from "./types";

const sourceFilePattern = "**/*.{cs,ts,tsx,js,jsx}";
const excludedFiles =
  "**/{.git,node_modules,bin,obj,dist,build,out,coverage,vendor}/**";

function isClass(symbol: vscode.DocumentSymbol): boolean {
  return symbol.kind === vscode.SymbolKind.Class;
}

function isMethod(symbol: vscode.DocumentSymbol): boolean {
  return (
    symbol.kind === vscode.SymbolKind.Method ||
    symbol.kind === vscode.SymbolKind.Constructor
  );
}

function collectSymbols(symbols: vscode.DocumentSymbol[]): string[] {
  const found: string[] = [];
  const visit = (
    children: vscode.DocumentSymbol[],
    containingClass?: string
  ): void => {
    for (const symbol of children) {
      if (isClass(symbol)) {
        found.push(`Class ${symbol.name}`);
        visit(symbol.children, symbol.name);
      } else {
        if (containingClass && isMethod(symbol)) {
          found.push(`Method ${containingClass}.${symbol.name}`);
        }
        visit(symbol.children, containingClass);
      }
    }
  };
  visit(symbols);
  return found;
}

export class ProjectScanner {
  constructor(readonly workspaceUri: vscode.Uri) {}

  async findSourceUris(): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(
      sourceFilePattern,
      excludedFiles
    );
  }

  getRelativePath(uri: vscode.Uri): string {
    return path
      .relative(this.workspaceUri.fsPath, uri.fsPath)
      .split(path.sep)
      .join("/");
  }

  async scanSourceFiles(
    uris: vscode.Uri[],
    includeWithoutSymbols = false
  ): Promise<ScannedSourceFile[]> {
    const scanned: Array<ScannedSourceFile | undefined> = [];
    for (let offset = 0; offset < uris.length; offset += 8) {
      const batch = uris.slice(offset, offset + 8);
      scanned.push(
        ...(await Promise.all(
          batch.map(async uri => {
            const document = await vscode.workspace.openTextDocument(uri);
            const symbols = await vscode.commands.executeCommand<
              vscode.DocumentSymbol[] | undefined
            >("vscode.executeDocumentSymbolProvider", uri);
            const detectedSymbols = symbols ? collectSymbols(symbols) : [];
            if (detectedSymbols.length === 0 && !includeWithoutSymbols) {
              return undefined;
            }

            return {
              uri,
              relativePath: this.getRelativePath(uri),
              content: document.getText(),
              symbols: detectedSymbols
            };
          })
        ))
      );
    }

    return scanned.filter(
      (file): file is ScannedSourceFile => file !== undefined
    );
  }
}
