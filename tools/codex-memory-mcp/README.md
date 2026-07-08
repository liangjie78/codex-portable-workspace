# codex-memory-mcp

Local-first knowledge-card RAG MVP for Codex.

This package is the reproducible tool layer. It does not contain this computer's memory data. The local knowledge base lives outside the package and is selected with `CODEX_MEMORY_ROOT`.

## Separation

```text
D:\Workspace\CodexMemory
  Local knowledge base for this machine only.

D:\Workspace\Projects\Project-013-CodexMemory\03_Source\codex-memory-mcp
  Portable MCP and CLI source code.
```

On another computer, copy or clone this package, create a local knowledge root for that machine, then set `CODEX_MEMORY_ROOT` to that local path.

## Knowledge Boundary

Store in CodexMemory:

- local environment facts and tool paths;
- Windows and PowerShell pitfalls;
- project history and reusable project lessons;
- build, test, verification and recovery workflows;
- common error symptoms, causes, fixes and evidence.

Do not store in CodexMemory:

- global hard rules;
- security policy;
- project directory rules;
- credentials, tokens, cookies, private production addresses;
- unreviewed long logs or one-off temporary commands.

Hard rules stay in `C:\Users\Administrator\.codex\AGENTS.md` and `D:\Workspace\01_全局工作台.md`. The RAG store is supporting memory only.

## Commands

Use PowerShell:

```powershell
$env:CODEX_MEMORY_ROOT = 'D:\Workspace\CodexMemory'
node src\cli.mjs validate
node src\cli.mjs reindex
node src\cli.mjs search "PowerShell 中文乱码" --limit 5
node src\cli.mjs search "PowerShell 中文乱码" --limit 5 --json
node src\cli.mjs get win-powershell-encoding-001
node src\cli.mjs finish .\task-completion.json
node scripts\eval.mjs
```

Run the MCP server:

```powershell
$env:CODEX_MEMORY_ROOT = 'D:\Workspace\CodexMemory'
node src\server.mjs
```

The local Codex config has been updated with `[mcp_servers.codex-memory]`. Restart Codex after config changes so a new session can load the MCP tool list.

Run a no-pollution smoke test:

```powershell
node scripts\smoke.mjs
```

## MCP Tools

- `rag_search(query, project?, type?, tags?, limit?)`
- `rag_get(id)`
- `rag_upsert(card)`
- `rag_finish_task(task_summary, project?, outcome?, source_path?, lessons)`
- `rag_validate()`
- `rag_reindex()`

`rag_finish_task` is the preferred completion hook. At the end of a task, the agent should decide whether the task produced reusable experience. If yes, pass 1-5 structured lessons. The tool writes cards and rebuilds the index. If there are no reusable lessons, do not write a filler card.

`rag_search` defaults to a compact text list so multiple Chinese results stay readable in Codex output. Pass `format: "json"` when a script needs structured fields, or `verbose: true` when the text list should include tags and short notes.

## Reproducibility

This MVP uses only Node.js built-in modules. No `npm install` is required.

The MCP server is portable; the knowledge base is not bundled. Each machine should initialize its own `CODEX_MEMORY_ROOT`.
