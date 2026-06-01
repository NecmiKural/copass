# copass 🧭

> **Context relay CLI tool** for switching between AI coding assistants with **zero context loss** when your rate limits/quota run out.

`copass` automatically discovers your local active AI coding assistant sessions, extracts the last few messages of your conversation, gathers the current git branch/diff/status, and generates a structured XML **handover prompt** copied directly to your clipboard. You can paste this prompt into your next AI assistant and resume your work exactly where you left off.

---

## Supported AI Assistants

| Assistant | Local Storage Path & Format | Project Matching Strategy |
| :--- | :--- | :--- |
| **Claude Code** | `~/.claude/projects/{encoded-path}/{session}.jsonl` | Encoded project filesystem path |
| **OpenAI Codex** | `~/.codex/sessions/{yyyy}/{mm}/{dd}/rollout-*.jsonl` | `session_meta` block's `cwd` field |
| **Antigravity (Gemini)** | `~/.gemini/antigravity/brain/{id}/.../transcript.jsonl` | Scans transcript content/tool arguments |
| **VS Code Copilot** | `~/Library/.../workspaceStorage/{hash}/chatSessions/*.jsonl` | Parses VS Code workspace metadata + rehydrates JSONL deltas |

---

## Features

- **Automatic Agent Discovery**: Automatically finds the most recently active assistant session for the current workspace.
- **Git Integration**: Appends current git branch, short status, diff statistics, and actual code diffs to the context.
- **Zero Dependencies**: Written using native Node.js ESM modules. No bloated `npm install`.
- **Clipboard Integration**: Automatically copies the handover XML payload to your clipboard using macOS `pbcopy`.
- **Targeted Selection**: Switch agents manually using the `--from` option if needed.

---

## Installation

Since `copass` has no external dependencies, you can install and link it globally using NPM:

1. Clone or download this repository.
2. Navigate to the project directory and run:
   ```bash
   npm link
   ```
3. Now you can run `copass` from any terminal!

---

## Command Reference

### 1. `copass list`
Lists all detected local AI agent sessions for the current project directory, showing their active status, message counts, and timestamps.

```bash
copass list
```

**Example Output:**
```text
  copass — Detected agent sessions  (/Users/necmikural/Documents/projects/my-app)

  ┌──────────────────┬────────┬──────────────────────┬──────────┬────────────────────┐
  │ Agent            │ Status │ Timestamp            │ Messages │ Git Branch         │
  ├──────────────────┼────────┼──────────────────────┼──────────┼────────────────────┤
  │ claude-code      │ ✅     │ 2026-05-30 09:45:12  │ 10       │ development        │
  │ codex            │ ❌     │ —                    │ —        │ —                  │
  │ antigravity      │ ✅     │ 2026-05-30 10:01:04  │ 6        │ development        │
  │ vscode-copilot   │ ❌     │ —                    │ —        │ —                  │
  └──────────────────┴────────┴──────────────────────┴──────────┴────────────────────┘
```

### 2. `copass relay`
Generates the handover XML document for the most recently active agent, saves it under `.copass/`, and copies it to your clipboard.

```bash
copass relay
```

#### Options:
* `--from <agent>`: Force relay from a specific agent (values: `claude-code`, `codex`, `antigravity`, `vscode-copilot`).
* `--messages <n>`: Number of message pairs (user + assistant) to include (default: `5`).
* `--dir <path>`: Run the relay for a specific project directory instead of the current working directory.

---

## How It Works (The Handover Payload)

The generated XML structure is highly descriptive and optimized for LLMs to ingest:

```xml
<handover>
  <meta>
    <source_agent>antigravity</source_agent>
    <session_id>e9905edb-31a4-414f-a791-f285bb76c192</session_id>
    <project>/Users/necmikural/Documents/projects/my-app</project>
    <git_branch>development</git_branch>
    <timestamp>2026-05-30T10:00:00.000Z</timestamp>
  </meta>

  <git_state>
    <status> M src/auth.js</status>
    <diff_summary> 1 file changed, 12 insertions(+), 2 deletions(-)</diff_summary>
    <diff_content>...</diff_content>
  </git_state>

  <conversation_context>
    <message role="user">Implement jwt signature verification</message>
    <message role="assistant">I've set up the JWT verification in auth.js. Next, we need to register it in the router middleware.</message>
  </conversation_context>

  <instruction>
    Read the context above. The previous agent (antigravity) ran out of quota, and I am handing this project over to you.
    Analyze the git state and conversation history, and continue exactly where we left off.
  </instruction>
</handover>
```

When you paste this into a new assistant (e.g., Claude Code or Codex), they will read the conversation history and current git diffs, understand the current goals, and prompt you to continue immediately.

---

## License

This project is licensed under the [MIT License](LICENSE). Feel free to share, modify, and distribute.
