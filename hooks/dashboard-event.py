#!/usr/bin/env python3
# Claude Dashboard hook — installed at ~/.claude/dashboard/hook.py and wired
# into ~/.claude/settings.json so Claude Code fires it on every lifecycle
# event (SessionStart, UserPromptSubmit, Stop, PermissionRequest, Notification,
# SessionEnd, etc.).
#
# Reads the event JSON from stdin, prepends a wall-clock timestamp and the
# event name (passed as argv[1]), and appends one JSON line to the log file
# the sidecar tails. Designed to be cheap, safe, and best-effort: any error
# is swallowed so it never blocks Claude Code.

import sys
import os
import json
import datetime

LOG = os.path.expanduser("~/.claude/dashboard-events.jsonl")


def main() -> int:
    event_name = sys.argv[1] if len(sys.argv) > 1 else "Unknown"
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {"_parse_error": True}

    record = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "event": event_name,
        "session_id": payload.get("session_id"),
        "cwd": payload.get("cwd"),
        "transcript_path": payload.get("transcript_path"),
        "matcher": payload.get("matcher"),
        "tool_name": payload.get("tool_name"),
        "permission_mode": payload.get("permission_mode"),
        "source": payload.get("source"),
    }

    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
