import * as vscode from "vscode";
import { BusinessLensCodeLensProvider } from "./codeLensProvider";
import { ChangeTracker } from "./changeTracker";
import { registerCommands } from "./commands";
import { DeepSeekService } from "./deepSeekService";
import { DocumentationService } from "./documentationService";
import { ProjectScanner } from "./projectScanner";

const supportedLanguages = [
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "csharp"
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const documentation = new DocumentationService(workspaceFolder.uri);
  const codeLensProvider = new BusinessLensCodeLensProvider(documentation);
  const scanner = new ProjectScanner(workspaceFolder.uri);
  const deepSeek = new DeepSeekService();
  const tracker = new ChangeTracker(
    workspaceFolder.uri,
    context.workspaceState,
    error => {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
  );
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.command = "businesslens.showPendingChanges";
  context.subscriptions.push(statusBar, codeLensProvider);

  const refreshStatus = async (): Promise<void> => {
    const hasDocumentation = await documentation.hasProjectDocumentation();
    statusBar.text = hasDocumentation
      ? `$(book) BusinessLens: Active${
          tracker.pendingCount ? ` • ${tracker.pendingCount} pending` : ""
        }`
      : `$(book) BusinessLens: Setup required${
          tracker.pendingCount ? ` • ${tracker.pendingCount} pending` : ""
        }`;
    statusBar.tooltip = hasDocumentation
      ? "Click to review changed files and update business documentation."
      : "Click to generate initial project documentation with DeepSeek.";
    statusBar.command = hasDocumentation
      ? "businesslens.showPendingChanges"
      : "businesslens.generateProjectDocumentation";
    statusBar.show();
  };

  try {
    await tracker.start(context);
  } catch (error) {
    await vscode.window.showErrorMessage(
      `BusinessLens change tracking could not start: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  context.subscriptions.push(
    tracker.onDidChange(() => {
      void refreshStatus().catch(error =>
        vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        )
      );
    })
  );

  await refreshStatus();
  try {
    await documentation.refreshIndex();
  } catch (error) {
    await vscode.window.showErrorMessage(
      error instanceof Error ? error.message : String(error)
    );
  }

  for (const language of supportedLanguages) {
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(
        { language },
        codeLensProvider
      )
    );
  }

  registerCommands(
    context,
    documentation,
    codeLensProvider,
    refreshStatus,
    scanner,
    deepSeek,
    tracker
  );

  const indexWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, ".business-docs/index.json")
  );
  const reloadIndex = async (): Promise<void> => {
    try {
      await documentation.refreshIndex();
    } catch (error) {
      await vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
    }
    await refreshStatus();
    codeLensProvider.refresh();
  };
  indexWatcher.onDidCreate(reloadIndex);
  indexWatcher.onDidChange(reloadIndex);
  indexWatcher.onDidDelete(reloadIndex);
  context.subscriptions.push(indexWatcher);
}

export function deactivate(): void {}
