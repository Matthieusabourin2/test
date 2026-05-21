#!/usr/bin/env osascript -l JavaScript
// Read Claude Desktop's sidebar via macOS Accessibility (AXUIElement).
//
// Reality check: Claude Desktop is Electron, and its AXWebArea exposes the
// entire rendered page as a deeply nested AX tree. Each property read is a
// 50-200ms IPC roundtrip. Walking deep into the conversation list takes
// minutes, not seconds. So we walk shallow, get the top-level sidebar
// labels (Pinned, Recents, mode buttons, account), and accept that
// per-conversation rows are out of reach via this transport.
//
// Output:  { items: [...], truncated?: true }
// Errors:  { error: "...", message? }

function run(argv) {
  try {
    const se = Application('System Events');
    se.includeStandardAdditions = true;

    let claudeProc;
    try {
      const matches = se.processes.whose({ name: 'Claude' })();
      if (!matches || matches.length === 0) {
        return JSON.stringify({ error: 'claude_not_running' });
      }
      claudeProc = matches[0];
    } catch (e) {
      return JSON.stringify({ error: 'no_permission', message: String(e) });
    }
    if (claudeProc.windows.length === 0) return JSON.stringify({ error: 'no_windows' });

    const maxNodes = parseInt(argv[0] || '500', 10);
    const maxDepth = parseInt(argv[1] || '17', 10);
    const maxKids  = parseInt(argv[2] || '30', 10);

    const collected = [];
    let nodeCount = 0;

    function safe(fn) { try { return fn(); } catch { return null; } }

    function walk(elem, depth) {
      if (nodeCount >= maxNodes) return;
      if (depth > maxDepth) return;
      nodeCount++;
      const role  = safe(() => elem.role()) || '?';
      const title = safe(() => elem.title());
      const desc  = safe(() => elem.description());
      const val   = safe(() => elem.value());
      const valStr = (typeof val === 'string') ? val : null;

      const info = { d: depth, r: role };
      if (title && title.length > 0 && title.length <= 250) info.t = title;
      if (desc && desc.length > 0 && desc.length <= 250 && desc !== title) info.desc = desc;
      if (valStr && valStr.length > 0 && valStr.length <= 250) info.v = valStr;
      collected.push(info);

      let kids = null;
      try { kids = elem.uiElements(); } catch {}
      if (!kids) return;
      const cap = Math.min(kids.length, maxKids);
      for (let i = 0; i < cap && nodeCount < maxNodes; i++) {
        try { walk(kids[i], depth + 1); } catch {}
      }
    }

    const wins = claudeProc.windows;
    for (let i = 0; i < wins.length && nodeCount < maxNodes; i++) {
      try { walk(wins[i], 0); } catch {}
    }

    return JSON.stringify({ items: collected, truncated: nodeCount >= maxNodes });
  } catch (e) {
    return JSON.stringify({ error: 'exception', message: String(e) });
  }
}
