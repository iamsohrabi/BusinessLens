import * as vscode from "vscode";

export interface SymbolDocumentation {
  className: string;
  methodName?: string;
}

export interface DocumentationEntry {
  file: string;
  methods: Record<string, string>;
}

export type DocumentationIndex = Record<string, DocumentationEntry>;

export interface BusinessContextDocument {
  uri: vscode.Uri;
  content: string;
  label: string;
  kind: "business" | "adr";
}

export interface ScannedSourceFile {
  uri: vscode.Uri;
  relativePath: string;
  content: string;
  originalContent: string;
  symbols: string[];
}

export interface GeneratedDocumentationFile {
  path: string;
  content: string;
}

export interface TrackedFileChange {
  relativePath: string;
  kind: "added" | "modified" | "deleted";
  gitStatus?: "staged" | "unstaged" | "untracked";
}
