import * as vscode from "vscode";
import { BusinessLensCodeLensProvider } from "./codeLensProvider";
import { ChangeTracker } from "./changeTracker";
import { DeepSeekService } from "./deepSeekService";
import { DocumentationService } from "./documentationService";
import { ProjectScanner } from "./projectScanner";
import { SymbolIgnoreService } from "./symbolIgnoreService";
import {
  ScannedSourceFile,
  SymbolDocumentation
} from "./types";

const maximumRequestCharacters = 100_000;
const reportedErrors = new Set<string>();

function sourceSize(sources: ScannedSourceFile[]): number {
  return sources.reduce(
    (total, source) => total + utf8Size(source.content),
    0
  );
}

function utf8Size(value: string): number {
  let size = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    size +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return size;
}

async function selectSources(
  scanner: ProjectScanner,
  uris: vscode.Uri[],
  includeWithoutSymbols = false,
  shouldIgnore?: (
    uri: vscode.Uri,
    symbol: SymbolDocumentation
  ) => boolean
): Promise<ScannedSourceFile[]> {
  const sources = await scanner.scanSourceFiles(
    uris,
    includeWithoutSymbols,
    shouldIgnore
  );
  if (sources.length === 0) {
    throw new Error(
      "No non-ignored source files containing detectable classes or methods were found."
    );
  }
  return sources;
}

async function applyGeneratedDocumentation(
  files: Awaited<ReturnType<DeepSeekService["generateProjectDocumentation"]>>,
  documentation: DocumentationService,
  tracker: ChangeTracker,
  sources: ScannedSourceFile[],
  refreshStatus: () => Promise<void>,
  codeLensProvider: BusinessLensCodeLensProvider,
  requireProjectFiles: boolean
): Promise<void> {
  if (
    requireProjectFiles &&
    (!files.some(file => file.path === "00-OVERVIEW.md") ||
      !files.some(file => file.path === "01-ARCHITECTURE.md") ||
      !files.some(file => file.path === "02-FLOWS.md") ||
      !files.some(file => file.path === "index.json"))
  ) {
    throw new Error(
      "DeepSeek did not return the required overview, architecture, flows, and index files."
    );
  }
  if (!files.some(file => file.path === "index.json")) {
    throw new Error("DeepSeek did not return an updated index.json.");
  }

  await documentation.writeGeneratedFiles(files, true);
  await tracker.markDocumented(sources);
  await refreshStatus();
  codeLensProvider.refresh();
}

async function reportCommandError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (reportedErrors.has(message)) {
    return;
  }
  reportedErrors.add(message);
  await vscode.window.showErrorMessage(message);
}

function withErrorNotification<TArguments extends unknown[]>(
  operation: (...args: TArguments) => Promise<void>
): (...args: TArguments) => Promise<void> {
  return (...args) => operation(...args).catch(reportCommandError);
}

function isSymbolDocumentation(value: unknown): value is SymbolDocumentation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<SymbolDocumentation>;
  return (
    typeof candidate.className === "string" &&
    (candidate.methodName === undefined ||
      typeof candidate.methodName === "string")
  );
}

function isUri(value: unknown): value is vscode.Uri {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<vscode.Uri>;
  return (
    typeof candidate.scheme === "string" &&
    typeof candidate.fsPath === "string" &&
    typeof candidate.toString === "function"
  );
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

async function symbolAtCursor(): Promise<SymbolDocumentation | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  const symbols = await vscode.commands.executeCommand<
    vscode.DocumentSymbol[] | undefined
  >("vscode.executeDocumentSymbolProvider", editor.document.uri);
  if (!symbols) {
    return undefined;
  }

  let match: { symbol: SymbolDocumentation; depth: number } | undefined;
  const position = editor.selection.active;
  const visit = (
    children: vscode.DocumentSymbol[],
    containingClass?: string,
    depth = 0
  ): void => {
    for (const symbol of children) {
      if (!symbol.range.contains(position)) {
        continue;
      }

      if (isClass(symbol)) {
        if (!match || depth >= match.depth) {
          match = { symbol: { className: symbol.name }, depth };
        }
        visit(symbol.children, symbol.name, depth + 1);
      } else {
        if (containingClass && isMethod(symbol) && (!match || depth >= match.depth)) {
          match = {
            symbol: { className: containingClass, methodName: symbol.name },
            depth
          };
        }
        visit(symbol.children, containingClass, depth + 1);
      }
    }
  };
  visit(symbols);
  return match?.symbol;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showBusinessContextPanel(
  title: string,
  documents: Awaited<ReturnType<DocumentationService["getBusinessContext"]>>
): void {
  const panel = vscode.window.createWebviewPanel(
    "businesslens.documentation",
    `BusinessLens: ${title}`,
    vscode.ViewColumn.Beside,
    { enableScripts: false }
  );
  const nonce = `${Date.now()}${Math.random().toString(16).slice(2)}`;
  const sections = documents
    .map(
      document => `<section>
  <h2>${document.kind === "adr" ? "Architecture decision" : "Business documentation"}</h2>
  <p class="source">${escapeHtml(document.label)}</p>
  <pre>${escapeHtml(document.content)}</pre>
</section>`
    )
    .join("\n");
  panel.webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">
    body { padding: 1.5rem; color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
    section { margin-bottom: 2rem; }
    h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .4rem; }
    .source { color: var(--vscode-descriptionForeground); font-size: .9em; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-font-family); line-height: 1.55; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${sections || "<p>No related business documentation or ADR was found.</p>"}
</body>
</html>`;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  documentation: DocumentationService,
  codeLensProvider: BusinessLensCodeLensProvider,
  refreshStatus: () => Promise<void>,
  scanner: ProjectScanner,
  deepSeek: DeepSeekService,
  tracker: ChangeTracker,
  ignoredSymbols: SymbolIgnoreService
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "businesslens.showDocumentation",
      async (argument?: unknown, label?: string) => {
        const symbol = isSymbolDocumentation(argument)
          ? argument
          : await symbolAtCursor();
        if (!symbol) {
          await vscode.window.showInformationMessage(
            "Place the cursor inside a class or method."
          );
          return;
        }

        const title =
          label ??
          (symbol.methodName
            ? `${symbol.className}.${symbol.methodName}`
            : symbol.className);
        const documents = await documentation.getBusinessContext(symbol);
        showBusinessContextPanel(title, documents);
      }
    ),
    vscode.commands.registerCommand(
      "businesslens.ignoreSymbol",
      withErrorNotification(
        async (argument?: unknown, uriArgument?: unknown) => {
          if (!isSymbolDocumentation(argument) || !isUri(uriArgument)) {
            throw new Error(
              "Cannot ignore this symbol because its location is missing."
            );
          }
          await ignoredSymbols.setIgnored(uriArgument, argument, true);
          codeLensProvider.refresh();
        }
      )
    ),
    vscode.commands.registerCommand(
      "businesslens.unignoreSymbol",
      withErrorNotification(
        async (argument?: unknown, uriArgument?: unknown) => {
          if (!isSymbolDocumentation(argument) || !isUri(uriArgument)) {
            throw new Error(
              "Cannot include this symbol because its location is missing."
            );
          }
          await ignoredSymbols.setIgnored(uriArgument, argument, false);
          codeLensProvider.refresh();
        }
      )
    ),
    vscode.commands.registerCommand(
      "businesslens.updateSymbol",
      async () => {
        const symbol = await symbolAtCursor();
        if (!symbol) {
          await vscode.window.showInformationMessage(
            "Place the cursor inside a class or method to update its documentation."
          );
          return;
        }
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }
        const relativePath = scanner.getRelativePath(editor.document.uri);
        await vscode.commands.executeCommand(
          "businesslens.updateChangedDocumentation",
          [relativePath]
        );
      }
    ),
    vscode.commands.registerCommand(
      "businesslens.generateProjectDocumentation",
      withErrorNotification(async () => {
        const sourceUris = await scanner.findSourceUris();
        const sources = await selectSources(
          scanner,
          sourceUris,
          false,
          (uri, symbol) => ignoredSymbols.isIgnored(uri, symbol)
        );
        if (sourceSize(sources) > maximumRequestCharacters) {
          throw new Error(
            "The project source exceeds the 100 KB automatic documentation request limit."
          );
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "BusinessLens: Generating project documentation with DeepSeek",
              cancellable: false
            },
            async () => {
              const files = await deepSeek.generateProjectDocumentation(sources);
              await applyGeneratedDocumentation(
                files,
                documentation,
                tracker,
                sources,
                refreshStatus,
                codeLensProvider,
                true
              );
            }
          );
        } catch (error) {
          await reportCommandError(error);
        }
      })
    ),
    vscode.commands.registerCommand(
      "businesslens.updateChangedDocumentation",
      withErrorNotification(async (requestedPaths?: string[]) => {
        if (!(await documentation.hasProjectDocumentation())) {
          await vscode.commands.executeCommand(
            "businesslens.generateProjectDocumentation"
          );
          return;
        }
        const pending = await tracker.getPendingChanges();
        if (pending.length === 0) {
          return;
        }

        const changes = requestedPaths
          ? pending.filter(change =>
              requestedPaths.includes(change.relativePath)
            )
          : pending;
        if (!changes?.length) {
          return;
        }

        const sourceUris = changes
          .filter(change => change.kind !== "deleted")
          .map(change =>
            vscode.Uri.joinPath(
              scanner.workspaceUri,
              ...change.relativePath.split("/")
            )
          );
        const sources = await scanner.scanSourceFiles(
          sourceUris,
          true,
          (uri, symbol) => ignoredSymbols.isIgnored(uri, symbol)
        );
        const sourceByPath = new Map(
          sources.map(source => [source.relativePath, source])
        );
        for (const change of changes) {
          if (change.kind === "deleted") {
            sourceByPath.set(change.relativePath, {
              uri: vscode.Uri.joinPath(
                scanner.workspaceUri,
                ...change.relativePath.split("/")
              ),
              relativePath: change.relativePath,
              content: "[SOURCE FILE DELETED]",
              originalContent: "[SOURCE FILE DELETED]",
              symbols: ["Deleted source file"]
            });
          }
        }
        const selectedSources = changes
          .map(change => sourceByPath.get(change.relativePath))
          .filter((source): source is ScannedSourceFile => source !== undefined);
        if (selectedSources.length !== changes.length) {
          await vscode.window.showErrorMessage(
            "Some selected source files could not be read. Refresh the pending-change list and try again."
          );
          return;
        }

        const existingFiles = await documentation.readBusinessDocumentationFiles();
        const existingSize = existingFiles.reduce(
          (total, file) => total + utf8Size(file.content),
          0
        );
        if (sourceSize(selectedSources) + existingSize > maximumRequestCharacters) {
          throw new Error(
            "The selected source changes and existing documentation exceed the 100 KB DeepSeek request limit."
          );
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "BusinessLens: Updating documentation with DeepSeek",
              cancellable: false
            },
            async () => {
              const files = await deepSeek.updateProjectDocumentation(
                selectedSources,
                existingFiles
              );
              await applyGeneratedDocumentation(
                files,
                documentation,
                tracker,
                selectedSources,
                refreshStatus,
                codeLensProvider,
                false
              );
            }
          );
        } catch (error) {
          await reportCommandError(error);
        }
      })
    ),
    vscode.commands.registerCommand(
      "businesslens.showPendingChanges",
      withErrorNotification(async () => {
        await vscode.commands.executeCommand(
          "businesslens.updateChangedDocumentation"
        );
      })
    ),
    vscode.commands.registerCommand(
      "businesslens.refreshIndex",
      async () => {
        try {
          await documentation.refreshIndex();
          await refreshStatus();
          codeLensProvider.refresh();
          await vscode.window.showInformationMessage(
            "BusinessLens documentation index refreshed."
          );
        } catch (error) {
          codeLensProvider.refresh();
          await vscode.window.showErrorMessage(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "businesslens.openDocsFolder",
      async () => {
        if (!(await documentation.hasDocsFolder())) {
          await vscode.window.showInformationMessage(
            "The .business-docs folder does not exist in this workspace."
          );
          return;
        }
        await vscode.commands.executeCommand(
          "revealInExplorer",
          documentation.docsUri
        );
      }
    )
  );
}
