import * as path from "node:path";
import * as vscode from "vscode";
import { SymbolDocumentation } from "./types";

const ignoredSymbolsKey = "businesslens.ignoredSymbols";

interface IgnoredSymbol {
  relativePath: string;
  className: string;
  methodName?: string;
}

export class SymbolIgnoreService {
  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento
  ) {}

  isClassIgnored(uri: vscode.Uri, className: string): boolean {
    return this.hasRecord(uri, { className });
  }

  isIgnored(uri: vscode.Uri, symbol: SymbolDocumentation): boolean {
    return (
      this.isClassIgnored(uri, symbol.className) ||
      (symbol.methodName !== undefined && this.hasRecord(uri, symbol))
    );
  }

  async setIgnored(
    uri: vscode.Uri,
    symbol: SymbolDocumentation,
    ignored: boolean
  ): Promise<void> {
    const record = this.toRecord(uri, symbol);
    const records = this.workspaceState.get<IgnoredSymbol[]>(
      ignoredSymbolsKey,
      []
    );
    const exists = records.some(item => this.matches(item, record));
    if (exists === ignored) {
      return;
    }

    const updated = ignored
      ? [...records, record]
      : records.filter(item => !this.matches(item, record));
    await this.workspaceState.update(ignoredSymbolsKey, updated);
  }

  private hasRecord(uri: vscode.Uri, symbol: SymbolDocumentation): boolean {
    const record = this.tryCreateRecord(uri, symbol);
    if (!record) {
      return false;
    }
    return this.workspaceState
      .get<IgnoredSymbol[]>(ignoredSymbolsKey, [])
      .some(item => this.matches(item, record));
  }

  private toRecord(
    uri: vscode.Uri,
    symbol: SymbolDocumentation
  ): IgnoredSymbol {
    const record = this.tryCreateRecord(uri, symbol);
    if (!record) {
      throw new Error("Cannot ignore a symbol outside the current workspace.");
    }
    return record;
  }

  private tryCreateRecord(
    uri: vscode.Uri,
    symbol: SymbolDocumentation
  ): IgnoredSymbol | undefined {
    const relativePath = path
      .relative(this.workspaceUri.fsPath, uri.fsPath)
      .split(path.sep)
      .join("/");
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      path.isAbsolute(relativePath)
    ) {
      return undefined;
    }

    return {
      relativePath,
      className: symbol.className,
      ...(symbol.methodName === undefined
        ? {}
        : { methodName: symbol.methodName })
    };
  }

  private matches(left: IgnoredSymbol, right: IgnoredSymbol): boolean {
    return (
      left.relativePath === right.relativePath &&
      left.className === right.className &&
      left.methodName === right.methodName
    );
  }
}
