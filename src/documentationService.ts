import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  BusinessContextDocument,
  DocumentationIndex,
  GeneratedDocumentationFile,
  SymbolDocumentation
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAdrPath(filePath: string): boolean {
  const parts = filePath.split(path.sep).map(part => part.toLowerCase());
  const baseName = path.basename(filePath);
  return (
    parts.some(part =>
      ["adr", "adrs", "decision", "decisions"].includes(part)
    ) ||
    /^adr[-_\s]?\d/i.test(baseName)
  );
}

function mentionsSymbol(content: string, symbol: SymbolDocumentation): boolean {
  const names = [symbol.className, symbol.methodName].filter(
    (name): name is string => Boolean(name)
  );
  return names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (/^[\p{L}\p{N}_$]+$/u.test(name)) {
      return new RegExp(
        `(^|[^\\p{L}\\p{N}_$])${escaped}(?=$|[^\\p{L}\\p{N}_$])`,
        "iu"
      ).test(content);
    }
    return content.toLowerCase().includes(name.toLowerCase());
  });
}

export class DocumentationService {
  readonly docsUri: vscode.Uri;
  private index: DocumentationIndex = {};
  private loaded = false;

  constructor(private readonly workspaceUri: vscode.Uri) {
    this.docsUri = vscode.Uri.joinPath(workspaceUri, ".business-docs");
  }

  async hasDocsFolder(): Promise<boolean> {
    try {
      return (await fs.stat(this.docsUri.fsPath)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async hasProjectDocumentation(): Promise<boolean> {
    try {
      const overviewUri = vscode.Uri.joinPath(
        this.docsUri,
        "00-OVERVIEW.md"
      );
      const indexUri = vscode.Uri.joinPath(this.docsUri, "index.json");
      const [overview, rawIndex] = await Promise.all([
        fs.stat(overviewUri.fsPath),
        fs.readFile(indexUri.fsPath, "utf8")
      ]);
      const parsed: unknown = JSON.parse(rawIndex);
      return overview.isFile() && isRecord(parsed);
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) {
        return false;
      }
      throw error;
    }
  }

  async refreshIndex(): Promise<void> {
    this.index = {};
    this.loaded = true;

    if (!(await this.hasDocsFolder())) {
      return;
    }

    const indexUri = vscode.Uri.joinPath(this.docsUri, "index.json");
    let rawIndex: string;
    try {
      rawIndex = await fs.readFile(indexUri.fsPath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawIndex);
    } catch (error) {
      throw new Error(
        `BusinessLens index.json is not valid JSON: ${(error as Error).message}`
      );
    }

    if (!isRecord(parsed)) {
      throw new Error("BusinessLens index.json must contain a JSON object.");
    }

    const nextIndex: DocumentationIndex = {};
    for (const [className, value] of Object.entries(parsed)) {
      if (!isRecord(value) || typeof value.file !== "string") {
        throw new Error(`Invalid documentation entry for "${className}".`);
      }

      const methods: Record<string, string> = {};
      if (value.methods !== undefined) {
        if (!isRecord(value.methods)) {
          throw new Error(`Invalid methods map for "${className}".`);
        }
        for (const [methodName, reference] of Object.entries(value.methods)) {
          if (typeof reference !== "string") {
            throw new Error(
              `Invalid documentation reference for "${className}.${methodName}".`
            );
          }
          this.resolveReference(reference);
          methods[methodName] = reference;
        }
      }

      this.resolveReference(value.file);
      nextIndex[className] = { file: value.file, methods };
    }

    this.index = nextIndex;
  }

  async getBusinessContext(
    symbol: SymbolDocumentation
  ): Promise<BusinessContextDocument[]> {
    const directReferences = new Set<string>();
    const classReference = await this.getReference({
      className: symbol.className
    });
    if (classReference) {
      directReferences.add(this.resolveReference(classReference).fsPath);
    }
    if (symbol.methodName) {
      const methodReference = await this.getReference(symbol);
      if (methodReference) {
        directReferences.add(this.resolveReference(methodReference).fsPath);
      }
    }

    const workspacePath = this.workspaceUri.fsPath;
    const adrRoots = [
      "adr",
      "adrs",
      "docs",
      "docs/adr",
      "docs/adrs",
      "docs/decisions",
      "docs/architecture/decisions"
    ].map(relativePath => path.join(workspacePath, relativePath));
    const files = new Set<string>([
      ...(await this.findMarkdownFiles(this.docsUri.fsPath)),
      ...(await Promise.all(adrRoots.map(root => this.findMarkdownFiles(root)))).flat()
    ]);

    const results: BusinessContextDocument[] = [];
    for (const filePath of files) {
      const direct = directReferences.has(filePath);
      const adr = isAdrPath(filePath);
      if (!direct && !adr && !filePath.startsWith(`${this.docsUri.fsPath}${path.sep}`)) {
        continue;
      }

      let content: string;
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if (isMissingFile(error)) {
          continue;
        }
        throw error;
      }

      if (!direct && !mentionsSymbol(content, symbol)) {
        continue;
      }

      const uri = vscode.Uri.file(filePath);
      results.push({
        uri,
        content,
        label: path.relative(workspacePath, filePath).split(path.sep).join("/"),
        kind: adr ? "adr" : "business"
      });
    }

    return results.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "business" ? -1 : 1;
      }
      return left.label.localeCompare(right.label);
    });
  }

  async readBusinessDocumentationFiles(): Promise<
    Array<{ path: string; content: string }>
  > {
    const files = await this.findMarkdownFiles(this.docsUri.fsPath);
    const indexPath = vscode.Uri.joinPath(this.docsUri, "index.json").fsPath;
    if (await this.fileExists(indexPath)) {
      files.push(indexPath);
    }

    return Promise.all(
      [...new Set(files)].map(async filePath => ({
        path: path.relative(this.docsUri.fsPath, filePath).split(path.sep).join("/"),
        content: await fs.readFile(filePath, "utf8")
      }))
    );
  }

  async writeGeneratedFiles(
    files: GeneratedDocumentationFile[],
    overwriteExisting: boolean
  ): Promise<void> {
    const validated = files.map(file => {
      const relativePath = file.path;
      const isTopLevelDocument = [
        "00-OVERVIEW.md",
        "01-ARCHITECTURE.md",
        "02-FLOWS.md",
        "index.json"
      ].includes(relativePath);
      const isClassDocument = /^classes\/[^/]+\.md$/i.test(relativePath);
      if (
        relativePath.includes("\\") ||
        path.posix.isAbsolute(relativePath) ||
        relativePath.split("/").some(part => part === "." || part === "..") ||
        (!isTopLevelDocument && !isClassDocument)
      ) {
        throw new Error(
          `DeepSeek returned an unsupported documentation path: "${relativePath}".`
        );
      }
      return {
        ...file,
        targetPath: path.resolve(this.docsUri.fsPath, relativePath)
      };
    });

    const uniquePaths = new Set(validated.map(file => file.targetPath));
    if (uniquePaths.size !== validated.length) {
      throw new Error("DeepSeek returned duplicate documentation paths.");
    }

    const indexFile = validated.find(file => file.path === "index.json");
    if (indexFile) {
      let parsedIndex: unknown;
      try {
        parsedIndex = JSON.parse(indexFile.content);
      } catch (error) {
        throw new Error(
          `DeepSeek returned invalid index.json: ${(error as Error).message}`
        );
      }
      if (!isRecord(parsedIndex)) {
        throw new Error("DeepSeek index.json must contain a JSON object.");
      }
      const generatedPaths = new Set(validated.map(file => file.targetPath));
      for (const [className, value] of Object.entries(parsedIndex)) {
        if (!isRecord(value) || typeof value.file !== "string") {
          throw new Error(`Invalid generated index entry for "${className}".`);
        }
        const classFilePath = this.resolveReference(value.file).fsPath;
        if (
          !generatedPaths.has(classFilePath) &&
          !(await this.fileExists(classFilePath))
        ) {
          throw new Error(
            `Generated index points to a missing class document: "${value.file}".`
          );
        }
        if (value.methods !== undefined) {
          if (!isRecord(value.methods)) {
            throw new Error(`Invalid generated methods map for "${className}".`);
          }
          for (const [methodName, reference] of Object.entries(value.methods)) {
            if (typeof reference !== "string") {
              throw new Error(
                `Invalid generated method reference for "${className}.${methodName}".`
              );
            }
            const methodFilePath = this.resolveReference(reference).fsPath;
            if (
              !generatedPaths.has(methodFilePath) &&
              !(await this.fileExists(methodFilePath))
            ) {
              throw new Error(
                `Generated index points to a missing method document: "${reference}".`
              );
            }
          }
        }
      }
    }

    for (const file of validated) {
      await this.assertNoSymlinkParent(file.targetPath);
      if (!overwriteExisting && (await this.fileExists(file.targetPath))) {
        throw new Error(
          `Refusing to overwrite existing documentation: ${file.path}`
        );
      }
    }

    await fs.mkdir(this.docsUri.fsPath, { recursive: true });
    const orderedFiles = [
      ...validated.filter(file => file !== indexFile),
      ...(indexFile ? [indexFile] : [])
    ];
    for (const file of orderedFiles) {
      await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
      await fs.writeFile(file.targetPath, file.content, "utf8");
    }

    if (indexFile) {
      await this.refreshIndex();
    }
  }

  private async getReference(
    symbol: SymbolDocumentation
  ): Promise<string | undefined> {
    if (!this.loaded) {
      await this.refreshIndex();
    }

    const entry = this.index[symbol.className];
    if (!entry) {
      return undefined;
    }

    return symbol.methodName
      ? entry.methods[symbol.methodName]
      : entry.file;
  }

  private async findMarkdownFiles(directory: string): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }

    const files: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.findMarkdownFiles(entryPath)));
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
        files.push(entryPath);
      }
    }
    return files;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if (isMissingFile(error)) {
        return false;
      }
      throw error;
    }
  }

  private async assertNoSymlinkParent(targetPath: string): Promise<void> {
    const relativeDirectory = path.relative(
      this.docsUri.fsPath,
      path.dirname(targetPath)
    );
    const directories = [
      this.docsUri.fsPath,
      ...relativeDirectory
        .split(path.sep)
        .filter(part => part && part !== ".")
        .reduce<string[]>((parts, part) => {
          parts.push(path.join(parts.at(-1) ?? this.docsUri.fsPath, part));
          return parts;
        }, [])
    ];

    for (const directory of directories) {
      try {
        const stats = await fs.lstat(directory);
        if (stats.isSymbolicLink()) {
          throw new Error(
            `Refusing to write documentation through a symbolic link: ${directory}`
          );
        }
      } catch (error) {
        if (isMissingFile(error)) {
          return;
        }
        throw error;
      }
    }

    try {
      if ((await fs.lstat(targetPath)).isSymbolicLink()) {
        throw new Error(
          `Refusing to overwrite a symbolic link: ${targetPath}`
        );
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }

  private resolveReference(reference: string): vscode.Uri {
    const relativeFile = reference.split("#", 1)[0];
    if (
      !relativeFile ||
      relativeFile.includes("\\") ||
      path.isAbsolute(relativeFile) ||
      path.win32.isAbsolute(relativeFile) ||
      path.extname(relativeFile).toLowerCase() !== ".md"
    ) {
      throw new Error(`Invalid BusinessLens documentation path: "${reference}".`);
    }

    const targetPath = path.resolve(this.docsUri.fsPath, relativeFile);
    const relativePath = path.relative(this.docsUri.fsPath, targetPath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`BusinessLens documentation path escapes its folder: "${reference}".`);
    }

    return vscode.Uri.file(targetPath);
  }
}
