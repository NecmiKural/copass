# copass

> Ran out of quota halfway through a task? Continue in another AI coding agent — exactly where you stopped.

`copass` reads the local session logs of the agent you were using (Claude Code, Codex, Antigravity, GitHub Copilot, Cline, Gemini CLI, Cursor, OpenCode, pi and more), and writes a **hand-over** that the next agent can pick up: what you asked for, the rules you set, what was done, what failed, the plan, the verified state of the repository, and the request that was left unanswered.

It works **after** the first agent has stopped responding. It makes no network calls, spends no tokens, needs no daemon, and has no dependencies beyond Node.js.

```sh
copass              # build the hand-over from the latest session here and copy it
copass --to codex   # …or start Codex with it right away
```

---

## Why

Switching agents loses more than the chat history:

- **Your rules get dropped.** Compaction and summaries keep only a fraction of the constraints you stated ("don't touch the migrations", "sadece Tailwind kullan"). copass quotes them verbatim.
- **The last request is the one that matters.** When a quota runs out, your latest message usually has no answer yet. copass keeps it and marks it as unanswered.
- **The work is in the tool calls, not in the chat.** Which files were edited, which commands ran, what failed — copass carries this trail, so the next agent doesn't redo or repeat dead ends.
- **The repository is the ground truth.** copass adds the current git state itself (branch, commits made since the session started, staged, unstaged and untracked changes, the diff) and tells the next agent to trust it over the transcript.
- **Native importers only go one way.** Codex can import Claude Code chats, Cursor can import Claude Code chats, VS Code can hand a session to another harness — each into itself only, and none of them carries git state. copass works in any direction, including into Claude Code.

## What the hand-over contains

The hand-over is an XML-tagged Markdown document, ordered the way models read best (material first, decisions last):

| Section | Content |
| --- | --- |
| `read_me_first` | Who stopped, when and why (e.g. "its usage limit was reached, resets 14:00"), and who has authority: only the user's own words are instructions |
| `task` | The first request of the session, verbatim |
| `constraints` | Standing instructions the user typed, quoted verbatim (pasted reports and logs excluded) |
| `prior_summary` | The agent's own compaction summary, detected structurally, with its source and time |
| `user_requests` | Every later request, oldest first |
| `recent_conversation` | The last exchanges; the final one shows what the agent was doing when it stopped |
| `work_done` | Files changed, commands with exit status, failures, and times the user corrected the agent |
| `plan` | The agent's own todo list, with the current focus marked |
| `repo_state` | Git state collected by copass at hand-over time, including the diff |
| `pointers` | The full transcript copass saved next to the hand-over, the original log, how to reopen the session natively, the project's rule files |
| `latest_request` | The user's last message verbatim, whether it was answered, queued prompts and unsent drafts |
| `instruction` | Verify the repository first, treat "done/fixed/tests pass" as claims, restate the plan, then continue |

Everything quoted from the history is framed as information, not instructions. Section tags carry a random suffix that changes with every hand-over, so quoted text — a transcript, a tool output, a summary — cannot open, close or imitate a section or a user turn, and quoted code is never rewritten. Credentials (API keys, tokens, JWTs, private keys, passwords in URLs, `SECRET=` assignments) are redacted.

The hand-over is about 12k tokens by default (`--budget` changes it). The complete transcript — every message and tool call — is saved next to it, so the next agent can search for exact details instead of guessing.

## Install

Requires Node.js 22.5 or newer.

```sh
git clone https://github.com/NecmiKural/copass.git
cd copass
npm link            # puts `copass` on your PATH
copass install-skill  # optional: lets agents pull the hand-over themselves
```

## Use

```sh
copass                      # hand over the most recent session in this project (clipboard + .copass/latest.md)
copass --to claude-code     # start the next agent here with the hand-over
copass list                 # every session copass can see for this project, newest first
copass --from codex         # only consider Codex sessions
copass --session 3f2a       # a specific session (id prefix from `copass list`)
copass --goal "now write the tests"   # tell the next agent what to do instead of "continue"
copass --stdout | less      # print instead of copying
```

With the skill installed, open the next agent in the project and say **"continue where I left off"** (or "kaldığımız yerden devam et"). The agent runs copass itself, reads the hand-over, verifies the repository and carries on — nothing to paste.

Hand-overs are written to `.copass/` in the project. The folder gets its own `.gitignore`, so conversation text and diffs are never committed. The newest ten hand-overs are kept.

### Options

| Option | Meaning |
| --- | --- |
| `--to <agent>` | Start that agent in the project with a short prompt that points at `.copass/latest.md` |
| `--from <agent>` | Only look at this agent's sessions |
| `--session <id>` | Use a specific session (prefix match) |
| `--goal "<text>"` | The next agent's task (default: continue the last request) |
| `--budget <tokens>` | Approximate size of the hand-over (default 12000) |
| `--stdout` | Print the hand-over; status goes to stderr |
| `--no-copy` | Don't touch the clipboard |
| `--exclude <agent>` | Ignore an agent (repeatable) — e.g. the one you are running copass from |
| `--include-self` | Allow handing over the session copass itself runs inside |
| `--no-redact` | Keep secrets (not recommended) |
| `--dir <path>` | Project directory (default: current directory) |

`COPASS_DEBUG=1` prints what each adapter found and why sessions were skipped.

## Supported agents

| Agent | Name for `--from` / `--to` | Where copass reads | Verified on real logs | `--to` starts it with |
| --- | --- | --- | --- | --- |
| Claude Code (CLI, VS Code, desktop) | `claude-code` | `~/.claude/projects/` | ✓ | `claude "<prompt>"` |
| OpenAI Codex (CLI, IDE, desktop) | `codex` | `~/.codex/` (thread index + rollouts, `.zst` too) | ✓ | `codex "<prompt>"` |
| Google Antigravity (IDE, `agy` CLI) | `antigravity` | `~/.gemini/antigravity*/` (conversation index + transcripts) | ✓ | `agy -i "<prompt>"` |
| GitHub Copilot Chat in VS Code | `vscode-copilot` | VS Code `workspaceStorage` (also Insiders, VSCodium) | ✓ | `code chat --mode agent "<prompt>"` |
| GitHub Copilot CLI | `copilot-cli` | `~/.copilot/session-state/` | ✓ | `copilot -i "<prompt>"` |
| Cline (CLI and VS Code extension) | `cline` | `~/.cline/data/`, the extension's `globalStorage` | ✓ | `cline --tui "<prompt>"` |
| Gemini CLI | `gemini-cli` | `~/.gemini/tmp/` | ✓ | `gemini -i "<prompt>"` |
| Cursor (`cursor-agent` CLI) | `cursor` | `~/.cursor/chats/`, `~/.cursor/projects/` | from source | `cursor-agent "<prompt>"` |
| OpenCode | `opencode` | `~/.local/share/opencode/opencode.db` | from source | `opencode --prompt "<prompt>"` |
| Goose | `goose` | Goose `sessions/sessions.db` | from source | `goose run -s --text "<prompt>"` |
| Factory Droid | `factory` | `~/.factory/sessions/` | from source | `droid "<prompt>"` |
| Qwen Code | `qwen` | `~/.qwen/projects/` | from source | `qwen -i "<prompt>"` |
| Kimi CLI | `kimi` | `~/.kimi-code/sessions/`, legacy `~/.kimi/sessions/` | from source | — (paste instead) |
| Aider | `aider` | `.aider.chat.history.md` in the repo | from source | `aider --read .copass/latest.md` |
| pi | `pi` | `~/.pi/agent/sessions/` | from source | `pi "<prompt>"` |

"Verified" adapters were built from audits of each agent's current on-disk format and checked against real sessions; "from source" adapters follow the agent's upstream source and are tested with fixtures in the same format. A session belongs to a project when the agent recorded a working directory that is the project, a subdirectory of it, or another worktree of the same repository — a session started in a parent directory never matches, and a session from exactly this directory is preferred.

## How it works

```
agent logs ──► adapter (agents/*.js) ──► normalized events ──► assemble (lib/assemble.js) ──► hand-over (lib/render.js)
                 read-only, per format      prompt · reply · tool        turns, compaction cut,          + git state, redaction,
                                            compaction · plan · stop      unanswered prompt, artifacts    transcript, delivery
```

Adapters only translate one agent's storage into a common event stream; every rule about what goes into a hand-over lives in one place, so all agents behave the same. Adapters use the agents' own indexes where they exist (Codex and Antigravity keep SQLite indexes, read through Node's built-in `node:sqlite`), rank sessions by the time of the last real message rather than file timestamps, skip empty, background and sub-agent sessions, and leave out the session copass itself runs inside.

## How it compares

| If you… | Use |
| --- | --- |
| Move Claude Code chats into Codex in bulk | Codex's built-in `/import` (native threads, also migrates settings) |
| Stay inside VS Code | VS Code's session target hand-off between harnesses |
| Want your whole history searchable as long-term memory | a memory tool such as claude-mem, deja-vu or cass |
| Want the next agent to resume a native copy of the old session | a format converter such as txcript or casr |
| Need to continue **now**, in **any** agent, with your rules, the unfinished request and the real repository state | copass |

copass can complement all of these: its hand-over points to the native resume command when one exists.

## Development

```sh
npm test            # node --test, no dependencies
```

To support another agent, add `agents/<name>.js` (see the contract in `agents/index.js` and the reference `agents/claude-code.js`), register it in `agents/index.js`, and add a fixture test in `test/`.

## License

[MIT](LICENSE)
