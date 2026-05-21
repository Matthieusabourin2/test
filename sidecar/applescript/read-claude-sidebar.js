#!/usr/bin/env osascript -l JavaScript
// Read Claude Desktop's sidebar via macOS Accessibility (AXUIElement) and
// return its UI tree as JSON on stdout. Always returns JSON.
// Output schema: { items: [{ d, r, sr?, t?, desc?, v?, h?, sel?, pr? }], truncated? }
// Error schema:  { error: "claude_not_running"|"no_permission"|"no_windows"|"exception", message? }

function run(argv) {
  try {
    const se = Application('System Events');
    se.includeStandardAdditions = true;

    let claudeProc, winCount;
    try {
      const matches = se.processes.whose({ name: 'Claude' })();
      if (!matches || matches.length === 0) {
        return JSON.stringify({ error: 'claude_not_running' });
      }
      claudeProc = matches[0];
      winCount = claudeProc.windows.length;
    } catch (e) {
      return JSON.stringify({ error: 'no_permission', message: String(e) });
    }

    if (winCount === 0) return JSON.stringify({ error: 'no_windows' });

    const maxNodes = parseInt(argv[0] || '4000', 10);
    const collected = [];
    let nodeCount = 0;

    function safe(fn) { try { return fn(); } catch { return null; } }

    function nodeInfo(elem, depth, parentRole) {
      if (nodeCount >= maxNodes) return null;
      nodeCount++;
      const role    = safe(() => elem.role())        || '?';
      const subrole = safe(() => elem.subrole())     || null;
      const title   = safe(() => elem.title())       || null;
      const desc    = safe(() => elem.description()) || null;
      const val     = safe(() => elem.value());
      const valStr  = (typeof val === 'string') ? val : null;
      const help    = safe(() => elem.help())        || null;
      const selected = safe(() => elem.selected());

      const info = { d: depth, r: role };
      if (subrole)   info.sr   = subrole;
      if (title)     info.t    = title;
      if (desc)      info.desc = desc;
      if (valStr)    info.v    = valStr;
      if (help)      info.h    = help;
      if (selected === true) info.sel = true;
      if (parentRole) info.pr  = parentRole;
      return info;
    }

    function walk(elem, depth, parentRole) {
      if (nodeCount >= maxNodes) return;
      const info = nodeInfo(elem, depth, parentRole);
      if (info) collected.push(info);
      const role = info ? info.r : '?';

      let kids = null;
      try { kids = elem.uiElements(); } catch {}
      if (!kids) return;
      const len = kids.length;
      for (let i = 0; i < len && nodeCount < maxNodes; i++) {
        try { walk(kids[i], depth + 1, role); } catch {}
      }
    }

    const wins = claudeProc.windows;
    for (let i = 0; i < winCount && nodeCount < maxNodes; i++) {
      try { walk(wins[i], 0, null); } catch {}
    }

    return JSON.stringify({ items: collected, truncated: nodeCount >= maxNodes });
  } catch (e) {
    return JSON.stringify({ error: 'exception', message: String(e) });
  }
}
