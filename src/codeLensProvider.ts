import * as vscode from "vscode";
import { DocumentationService } from "./documentationService";
import { SymbolDocumentation } from "./types";

interface LensCandidate {
  range: vscode.Range;
  symbol: SymbolDocumentation;
}

function isClass(symbol: vscode.DocumentSymbol): boolean {
  return symbol.kind === vscode.SymbolKind.Class;
}

function isMethod(symbol: vscode.DocumentSymbol): boolean {
  return (
    symbol.kind === vscode.SymbolKind.Method ||
    symbol.kind === vscode.SymbolKind.Constructor
  );
}

export class BusinessLensCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(private readonly documentation: DocumentationService) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  async provideCodeLenses(
    document: vscode.TextDocument
  ): Promise<vscode.CodeLens[]> {
    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[] | undefined
    >("vscode.executeDocumentSymbolProvider", document.uri);
    if (!symbols) {
      return [];
    }

    const candidates: LensCandidate[] = [];
    const visit = (
      children: vscode.DocumentSymbol[],
      containingClass?: string
    ): void => {
      for (const symbol of children) {
        if (isClass(symbol)) {
          candidates.push({
            range: symbol.selectionRange,
            symbol: { className: symbol.name }
          });
          visit(symbol.children, symbol.name);
          continue;
        }

        if (containingClass && isMethod(symbol)) {
          candidates.push({
            range: symbol.selectionRange,
            symbol: { className: containingClass, methodName: symbol.name }
          });
        }
        visit(symbol.children, containingClass);
      }
    };
    visit(symbols);

    return candidates.map(candidate => {
        const label = candidate.symbol.methodName
          ? `${candidate.symbol.className}.${candidate.symbol.methodName}`
          : candidate.symbol.className;
        return new vscode.CodeLens(candidate.range, {
          title: "$(lightbulb) Why?",
          command: "businesslens.showDocumentation",
          arguments: [candidate.symbol, label]
        });
      });
  }
}
