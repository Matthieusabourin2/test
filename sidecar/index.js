#!/usr/bin/env node
// Claude Dashboard sidecar
//
// Scans ~/.claude/projects/**/*.jsonl on a 2s interval, derives a per-session
// status mirroring Claude Code's sidebar semantics, and pushes updates over SSE.
// Zero npm dependencies — Node standard library only.

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execP = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects');
const PORT = parseInt(process.env.PORT || '8765', 10);

// Status thresholds aligned with Claude Code's own sidebar:
//   blue pulse    = actively writing right now
//   green pulse   = finished, unread (atime <= mtime: file hasn't been opened since
//                   the last assistant write)
//   green solid   = finished, read (atime > mtime: user opened the session)
//   red pulse     = stuck on a tool_use for > NEEDS_ACTION_MS, likely a permission
//                   prompt or other blocked-on-user state
//   gray (idle)   = > 24h with no activity, displayed dimmed
const VERY_RECENT_MS   = 60 * 1000;
const NEEDS_ACTION_MS  = 5 * 60 * 1000;
const IDLE_MS          = 24 * 60 * 60 * 1000;       // grayed after 24h
const HIDDEN_MS        = 7 * 24 * 60 * 60 * 1000;   // dropped after 7d
const POLL_INTERVAL_MS = 2000;
const GIT_POLL_MS      = 30000;
const TAIL_BYTES       = 32 * 1024;
const HEAD_BYTES       = 8 * 1024;

const sessions = new Map();
const sseClients = new Set();
const mergedBranches = new Map();
let lastSnapshot = '';

async function safeStat(p) { try { return await stat(p); } catch { return null; } }
async function readHead(file) {
  const buf = await readFile(file);
  return buf.subarray(0, Math.min(HEAD_BYTES, buf.length)).toString('utf-8');
}
async function readTail(file) {
  const buf = await readFile(file);
  const start = Math.max(0, buf.length - TAIL_BYTES);
  return { text: buf.subarray(start).toString('utf-8'), startedAtZero: start === 0 };
}
function parseLines(text, dropFirst) {
  const lines = text.split('\n').filter(Boolean);
  if (dropFirst && lines.length) lines.shift();
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

function deriveStatus({ lastEvent, lastEventTime, mtimeMs }) {
  const ref = Math.max(lastEventTime || 0, mtimeMs || 0);
  const age = Date.now() - ref;
  if (age > IDLE_MS) return 'idle';
  if (age < VERY_RECENT_MS) return 'working';
  // Anything else: Claude wrote something and stopped. From the JSONL alone
  // we can't reliably tell "finished cleanly" from "stopped mid-flow", so we
  // collapse both into "awaiting" and let the dashboard decide read/unread
  // by tracking the user's last interaction with each session.
  return 'awaiting';
}

async function scanFile(filePath) {
  const st = await safeStat(filePath);
  if (!st || !st.isFile()) return null;

  let aiTitle = null, cwd = null, gitBranch = null, sessionId = null;
  try {
    const head = await readHead(filePath);
    for (const ev of parseLines(head, false)) {
      if (ev.type === 'ai-title' && ev.aiTitle) aiTitle = ev.aiTitle;
      if (!cwd && ev.cwd) cwd = ev.cwd;
      if (!gitBranch && ev.gitBranch) gitBranch = ev.gitBranch;
      if (!sessionId && ev.sessionId) sessionId = ev.sessionId;
    }
  } catch {}

  let lastEvent = null;
  try {
    const tail = await readTail(filePath);
    const evs = parseLines(tail.text, !tail.startedAtZero);
    lastEvent = evs[evs.length - 1] || null;
    for (const ev of evs.slice().reverse()) {
      if (!cwd && ev.cwd) cwd = ev.cwd;
      if (!gitBranch && ev.gitBranch) gitBranch = ev.gitBranch;
      if (cwd && gitBranch) break;
    }
  } catch {}

  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');
  const lastEventTime = lastEvent?.timestamp ? Date.parse(lastEvent.timestamp) : st.mtimeMs;
  const mergedKey = cwd && gitBranch ? `${cwd}::${gitBranch}` : null;
  const branchMerged = mergedKey ? mergedBranches.get(mergedKey) === true : false;

  const status = deriveStatus({
    lastEvent,
    lastEventTime,
    mtimeMs: st.mtimeMs,
  });

  return {
    sessionId,
    filePath,
    project: cwd ? path.basename(cwd) : path.basename(path.dirname(filePath)),
    cwd,
    gitBranch,
    title: aiTitle,
    lastEventTime: Math.max(lastEventTime || 0, st.mtimeMs),
    status,
    branchMerged,
  };
}

async function listRecentJsonl(dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'memory') continue;
      await listRecentJsonl(p, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      const st = await safeStat(p);
      if (!st) continue;
      // Pre-filter: drop sessions older than the hidden threshold (~7d) before
      // touching them. Anything within that window is kept so we can show it
      // grayed if it crosses into idle territory.
      if (Date.now() - st.mtimeMs > HIDDEN_MS) continue;
      out.push(p);
    }
  }
  return out;
}

async function fullScan() {
  const files = await listRecentJsonl(PROJECTS_DIR);
  const next = new Map();
  for (const p of files) {
    const data = await scanFile(p);
    if (data) next.set(p, data);
  }
  sessions.clear();
  for (const [k, v] of next) sessions.set(k, v);

  const snap = JSON.stringify(snapshot());
  if (snap !== lastSnapshot) {
    lastSnapshot = snap;
    broadcast({ type: 'snapshot', sessions: snapshot() });
  }
}

function snapshot() {
  const order = { working: 0, awaiting: 1, idle: 2 };
  return Array.from(sessions.values()).sort((a, b) => {
    const oa = order[a.status] ?? 99, ob = order[b.status] ?? 99;
    if (oa !== ob) return oa - ob;
    return b.lastEventTime - a.lastEventTime;
  });
}

async function refreshGitMerged() {
  const seen = new Set();
  for (const data of sessions.values()) {
    if (!data.gitBranch) continue;
    const cwd = data.cwd || (data.filePath ? path.dirname(data.filePath) : null);
    if (!cwd) continue;
    const key = `${cwd}::${data.gitBranch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let merged = false;
    for (const base of ['main', 'master']) {
      try {
        const { stdout } = await execP(`git -C "${cwd}" branch --merged ${base} 2>/dev/null`);
        if (stdout.split('\n').some(l => l.replace(/^\*?\s+/, '').trim() === data.gitBranch)) {
          merged = true; break;
        }
      } catch {}
    }
    mergedBranches.set(key, merged);
  }
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch {} }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
async function serveStatic(res, filePath) {
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ sessions: snapshot() }));
    return;
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', sessions: snapshot() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    await serveStatic(res, path.join(REPO_ROOT, 'index.html'));
    return;
  }
  res.writeHead(404).end('not found');
});

(async () => {
  console.log(`[sidecar] scanning ${PROJECTS_DIR} ...`);
  const exists = await safeStat(PROJECTS_DIR);
  if (!exists) {
    console.error(`[sidecar] ${PROJECTS_DIR} does not exist. Have you run Claude Code at least once?`);
    process.exit(1);
  }
  await fullScan();
  await refreshGitMerged();
  await fullScan(); // re-derive statuses now that merged state is known
  console.log(`[sidecar] ready → http://localhost:${PORT}/  (showing ${sessions.size} active sessions, refresh every ${POLL_INTERVAL_MS}ms)`);

  setInterval(fullScan, POLL_INTERVAL_MS);
  setInterval(refreshGitMerged, GIT_POLL_MS);
  server.listen(PORT, '127.0.0.1');
})();
