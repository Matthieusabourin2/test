# Sidecar

Local Node.js service that watches your Claude Code sessions on disk and exposes their status to the dashboard in real time.

## What it covers today (v1)

- ✅ **Claude Code Desktop sessions** — read from `~/.claude/projects/**/*.jsonl`.
- ⏳ **Claude Desktop Chat** — not yet (lives on Anthropic servers, separate mechanism needed).
- ⏳ **Claude Cowork** — not yet (same reason as Chat).

Chat and Cowork integration is being worked on next.

## Setup (macOS / Linux / Windows with Node ≥ 18)

```bash
cd sidecar
node index.js
```

Then open the URL it prints (default `http://localhost:8765/`). No npm install — zero dependencies.

## What you get

For each Claude Code session on disk, the dashboard shows a colored status:

| Pill | Meaning |
|---|---|
| 🔵 *en cours* / *Claude réfléchit* | Session active (recent activity, Claude working) |
| 🟤 *attend ta réponse* | Claude finished a turn, waiting for you |
| 🔴 *bloqué* | A tool call stalled (no progress for > 1 min) |
| ⚪ *inactive* | No activity for > 5 min |
| 🟢 *mergé* | The session's branch was merged into `main` |

Sessions are sorted by priority (actions expected first), and the panel auto-refreshes via Server-Sent Events.

## Configuration

- `PORT` env var (default `8765`)
