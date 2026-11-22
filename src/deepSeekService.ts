import {
  GeneratedDocumentationFile,
  ScannedSourceFile
} from "./types";

export class DeepSeekService {
  async generateProjectDocumentation(
    _sources: ScannedSourceFile[]
  ): Promise<GeneratedDocumentationFile[]> {
    throw new Error(
      "BusinessLens backend is not configured. DeepSeek integration will be available when the backend is connected."
    );
  }

  async updateProjectDocumentation(
    _sources: ScannedSourceFile[],
    _existingFiles: Array<{ path: string; content: string }>
  ): Promise<GeneratedDocumentationFile[]> {
    throw new Error(
      "BusinessLens backend is not configured. DeepSeek integration will be available when the backend is connected."
    );
  }
}
