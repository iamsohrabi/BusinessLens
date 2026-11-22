# BusinessLens

BusinessLens is a VS Code extension for understanding the business purpose of
TypeScript, JavaScript, and C# classes and methods. It displays related Markdown
documentation and ADRs and tracks source changes.

## Development

1. Open this folder in VS Code.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` to launch the Extension Development Host.
5. In the new window, open `examples/ExampleService.ts` to see the sample
   BusinessLens CodeLens entries.

The included `.business-docs` directory is a sample documentation set used to
try the extension immediately.

## Backend integration

The DeepSeek API key and direct API calls have been removed. No source code or
documentation is sent to DeepSeek by this extension. The generation and update
commands currently report that a backend must be connected first.

## Change tracking

BusinessLens records SHA-256 snapshots of source files when their documentation
is generated or updated. Later edits remain pending until you select them for a
DeepSeek update. This survives commits and VS Code restarts. When the built-in
Git extension is available, pending entries also show whether a change is
staged, unstaged, or untracked; local file tracking continues to work without
Git.

- The status-bar item shows how many source files are pending.
- Run **BusinessLens: Show Pending Documentation Changes** or
  **BusinessLens: Update Documentation for Changed Files** to inspect tracked
  changes. Updating them requires the backend integration.
- **BusinessLens: Update Symbol Documentation** selects the current source
  file for the update command.

## Viewing documentation

- Place the cursor inside a documented class or method and run **BusinessLens:
  Show Documentation**, or click the book CodeLens above a class or method.
  The panel collects its indexed class/method documentation and Markdown files
  under `.business-docs/` or `docs/` that mention the symbol.
- Run **BusinessLens: Refresh Documentation Index** after changing the index.
- Run **BusinessLens: Open Documentation Folder** to reveal `.business-docs`
  in the Explorer.

BusinessLens activates for TypeScript, JavaScript, and C# files, or when the
workspace contains `.business-docs`. The active status-bar item is shown when
that folder exists. C# symbol discovery requires a C# language extension that
provides document symbols (for example, C# Dev Kit).

## Documentation index format

Each top-level key is a class name. The `file` value points to the class
Markdown file relative to `.business-docs`; `methods` maps method names to a
Markdown file and optional heading anchor.

```json
{
  "UserService": {
    "file": "classes/UserService.md",
    "methods": {
      "createUser": "classes/UserService.md#createUser"
    }
  }
}
```

Documentation paths must remain inside `.business-docs` and use `.md` files.
Related Markdown files are detected under `.business-docs/` and `docs/`.
ADR Markdown files are identified under `adr/`, `adrs/`, `docs/adr/`,
`docs/adrs/`, `docs/decisions/`, or `docs/architecture/decisions/` and included
when their content mentions the selected class or method. ADR files can also
live under `.business-docs/`.
