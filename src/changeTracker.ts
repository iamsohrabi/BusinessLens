import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ProjectScanner } from "./projectScanner";
import { ScannedSourceFile, TrackedFileChange } from "./types";

const baselineKey = "businesslens.documentedFileHashes";
const sourceFilePattern = "**/*.{cs,ts,tsx,js,jsx}";

interface GitResourceChange {
  uri: vscode.Uri;
}

interface GitRepositoryState {
  workingTreeChanges: GitResourceChange[];
  indexChanges: GitResourceChange[];
  untrackedChanges: vscode.Uri[];
  onDidChange: vscode.Event<void>;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

type FileBaselines = Record<string, string>;
type PendingChanges = Record<string, TrackedFileChange>;

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function contentHash(content: string): string {
  return createHash("sha256")
    .update(content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"))
    .digest("hex");
}

export class ChangeTracker implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly baseline: FileBaselines;
  private pending: PendingChanges = {};
  private readonly gitStatuses = new Map<string, TrackedFileChange["gitStatus"]>();
  private readonly gitListeners = new Map<GitRepository, vscode.Disposable>();

  constructor(
    private readonly workspaceUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
    private readonly onError: (error: unknown) => void
  ) {
    this.baseline =
      workspaceState.get<FileBaselines>(baselineKey, {});
  }

  async start(context: vscode.ExtensionContext): Promise<void> {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceUri, sourceFilePattern)
    );
    const onChangedUri = (uri: vscode.Uri): void => {
      this.runSafely(() => this.trackUri(uri));
    };
    watcher.onDidCreate(onChangedUri);
    watcher.onDidChange(onChangedUri);
    watcher.onDidDelete(uri => {
      this.markDeleted(uri);
    });

    context.subscriptions.push(
      watcher,
      vscode.workspace.onDidSaveTextDocument(document => {
        this.runSafely(() => this.trackUri(document.uri));
      }),
      vscode.workspace.onDidDeleteFiles(event => {
        for (const file of event.files) {
          this.markDeleted(file);
        }
      }),
      vscode.workspace.onDidRenameFiles(event => {
        for (const file of event.files) {
          this.markDeleted(file.oldUri);
          this.runSafely(() => this.trackUri(file.newUri));
        }
      }),
      this
    );

    await this.connectToGit(context);
    await this.refresh();
  }

  async getPendingChanges(): Promise<TrackedFileChange[]> {
    await this.refresh();
    return Object.values(this.pending).sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    );
  }

  get pendingCount(): number {
    return Object.keys(this.pending).length;
  }

  async markDocumented(sources: ScannedSourceFile[]): Promise<void> {
    for (const source of sources) {
      const { relativePath } = source;
      if (source.content === "[SOURCE FILE DELETED]") {
        delete this.baseline[relativePath];
        delete this.pending[relativePath];
        continue;
      }

      const submittedHash = contentHash(source.content);
      this.baseline[relativePath] = submittedHash;
      const uri = vscode.Uri.joinPath(
        this.workspaceUri,
        ...relativePath.split("/")
      );
      try {
        const content = await fs.readFile(uri.fsPath, "utf8");
        const currentHash = contentHash(content);
        if (currentHash === submittedHash) {
          delete this.pending[relativePath];
        } else {
          this.pending[relativePath] = {
            relativePath,
            kind: "modified",
            gitStatus: this.gitStatuses.get(relativePath)
          };
        }
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
        this.pending[relativePath] = {
          relativePath,
          kind: "deleted",
          gitStatus: this.gitStatuses.get(relativePath)
        };
      }
    }
    await this.persist();
    this.changeEmitter.fire();
  }

  async refresh(): Promise<void> {
    const scanner = new ProjectScanner(this.workspaceUri);
    const uris = await scanner.findSourceUris();
    const currentPaths = new Set<string>();

    await Promise.all(
      uris.map(async uri => {
        const relativePath = this.toRelativePath(uri);
        if (!relativePath) {
          return;
        }
        currentPaths.add(relativePath);
        await this.trackUri(uri, false, false);
      })
    );

    for (const [relativePath, hash] of Object.entries(this.baseline)) {
      if (!currentPaths.has(relativePath)) {
        this.pending[relativePath] = {
          relativePath,
          kind: "deleted",
          gitStatus: this.gitStatuses.get(relativePath)
        };
        if (!hash) {
          delete this.baseline[relativePath];
        }
      }
    }

    await this.persist();
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
    for (const listener of this.gitListeners.values()) {
      listener.dispose();
    }
    this.gitListeners.clear();
  }

  private async connectToGit(
    context: vscode.ExtensionContext
  ): Promise<void> {
    const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!gitExtension) {
      return;
    }

    try {
      const gitApi = gitExtension.isActive
        ? gitExtension.exports.getAPI(1)
        : (await gitExtension.activate()).getAPI(1);
      const listenToRepository = (repository: GitRepository): void => {
        const listener = repository.state.onDidChange(() => {
          this.updateGitStatuses(gitApi.repositories);
          this.changeEmitter.fire();
        });
        this.gitListeners.set(repository, listener);
        context.subscriptions.push(listener);
      };

      for (const repository of gitApi.repositories) {
        listenToRepository(repository);
      }
      context.subscriptions.push(
        gitApi.onDidOpenRepository(repository => {
          listenToRepository(repository);
          this.updateGitStatuses(gitApi.repositories);
          this.changeEmitter.fire();
        })
      );
      this.updateGitStatuses(gitApi.repositories);
    } catch (error) {
      this.onError(error);
    }
  }

  private updateGitStatuses(repositories: GitRepository[]): void {
    this.gitStatuses.clear();
    for (const repository of repositories) {
      for (const change of repository.state.workingTreeChanges) {
        const relativePath = this.toRelativePath(change.uri);
        if (relativePath) {
          this.gitStatuses.set(relativePath, "unstaged");
        }
      }
      for (const change of repository.state.indexChanges) {
        const relativePath = this.toRelativePath(change.uri);
        if (relativePath) {
          this.gitStatuses.set(relativePath, "staged");
        }
      }
      for (const uri of repository.state.untrackedChanges) {
        const relativePath = this.toRelativePath(uri);
        if (relativePath) {
          this.gitStatuses.set(relativePath, "untracked");
        }
      }
    }

    for (const [relativePath, change] of Object.entries(this.pending)) {
      change.gitStatus = this.gitStatuses.get(relativePath);
    }
  }

  private async trackUri(
    uri: vscode.Uri,
    persistChanges = true,
    emitChange = true
  ): Promise<void> {
    const relativePath = this.toRelativePath(uri);
    if (!relativePath) {
      return;
    }

    try {
      const content = await fs.readFile(uri.fsPath, "utf8");
      const hash = contentHash(content);
      const baselineHash = this.baseline[relativePath];
      if (baselineHash === hash) {
        delete this.pending[relativePath];
      } else {
        this.pending[relativePath] = {
          relativePath,
          kind: baselineHash ? "modified" : "added",
          gitStatus: this.gitStatuses.get(relativePath)
        };
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
      this.markDeleted(uri);
      return;
    }

    if (persistChanges) {
      await this.persist();
    }
    if (emitChange) {
      this.changeEmitter.fire();
    }
  }

  private markDeleted(uri: vscode.Uri): void {
    const relativePath = this.toRelativePath(uri);
    if (!relativePath) {
      return;
    }

    if (this.baseline[relativePath]) {
      this.pending[relativePath] = {
        relativePath,
        kind: "deleted",
        gitStatus: this.gitStatuses.get(relativePath)
      };
    } else {
      delete this.pending[relativePath];
    }
    this.runSafely(() => this.persist());
    this.changeEmitter.fire();
  }

  private toRelativePath(uri: vscode.Uri): string | undefined {
    const relativePath = path.relative(this.workspaceUri.fsPath, uri.fsPath);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath) ||
      !/\.(cs|ts|tsx|js|jsx)$/i.test(relativePath)
    ) {
      return undefined;
    }
    return relativePath.split(path.sep).join("/");
  }

  private async persist(): Promise<void> {
    await this.workspaceState.update(baselineKey, this.baseline);
    await this.workspaceState.update(
      "businesslens.pendingFileChanges",
      this.pending
    );
  }

  private runSafely(operation: () => Promise<void>): void {
    void operation().catch(this.onError);
  }
}
