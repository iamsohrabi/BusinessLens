import * as path from "node:path";
import * as vscode from "vscode";
import { ScannedSourceFile, SymbolDocumentation } from "./types";

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

interface FilteredSymbols {
  names: string[];
  excludedRanges: vscode.Range[];
}

function collectSymbols(
  symbols: vscode.DocumentSymbol[],
  uri: vscode.Uri,
  shouldIgnore: (uri: vscode.Uri, symbol: SymbolDocumentation) => boolean
): FilteredSymbols {
  const found: string[] = [];
  const excludedRanges: vscode.Range[] = [];
  const visit = (
    children: vscode.DocumentSymbol[],
    containingClass?: string
  ): void => {
    for (const symbol of children) {
      if (isClass(symbol)) {
        const classSymbol = { className: symbol.name };
        if (shouldIgnore(uri, classSymbol)) {
          excludedRanges.push(symbol.range);
          continue;
        }
        found.push(`Class ${symbol.name}`);
        visit(symbol.children, symbol.name);
      } else {
        if (containingClass && isMethod(symbol)) {
          const method = {
            className: containingClass,
            methodName: symbol.name
          };
          if (shouldIgnore(uri, method)) {
            excludedRanges.push(symbol.range);
            continue;
          }
          found.push(`Method ${containingClass}.${symbol.name}`);
        }
        visit(symbol.children, containingClass);
      }
    }
  };
  visit(symbols);
  return { names: found, excludedRanges };
}

function removeRanges(
  document: vscode.TextDocument,
  ranges: vscode.Range[]
): string {
  let content = document.getText();
  const offsets = ranges
    .map(range => ({
      start: document.offsetAt(range.start),
      end: document.offsetAt(range.end)
    }))
    .sort((left, right) => right.start - left.start);

  for (const range of offsets) {
    content = content.slice(0, range.start) + content.slice(range.end);
  }
  return content;
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
    includeWithoutSymbols = false,
    shouldIgnore: (
      uri: vscode.Uri,
      symbol: SymbolDocumentation
    ) => boolean = () => false
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
            const filteredSymbols = symbols
              ? collectSymbols(symbols, uri, shouldIgnore)
              : { names: [], excludedRanges: [] };
            if (filteredSymbols.names.length === 0 && !includeWithoutSymbols) {
              return undefined;
            }

            const originalContent = document.getText();
            return {
              uri,
              relativePath: this.getRelativePath(uri),
              content: removeRanges(document, filteredSymbols.excludedRanges),
              originalContent,
              symbols: filteredSymbols.names
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
