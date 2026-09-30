import { getStore } from "@netlify/blobs";

const KEY = "board-state";
const LINES = ["main", "express"];
const LINE_NAMES = { main: "Main line", express: "Express" };
const LOG_CAP = 500;

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clean = (v, n) => (v || "").toString().trim().slice(0, n) || null;

function blank() {
  return { lines: { main: { techs: [] }, express: { techs: [] } }, log: [], lastUpdate: null };
}

// Upgrades the old single-rotation format; existing techs land on the main line,
// and old log entries are marked untracked so they don't show up as vehicles still in shop.
function migrate(raw) {
  if (!raw || typeof raw !== "object") return blank();
  let s = raw;
  if (!s.lines) {
    s = {
      lines: { main: { techs: Array.isArray(raw.techs) ? raw.techs : [] }, express: { techs: [] } },
      log: (Array.isArray(raw.log) ? raw.log : []).map((e) => ({
        ...e,
        line: "main",
        untracked: true,
        completedAt: e.completedAt || e.time,
      })),
      lastUpdate: raw.lastUpdate || null,
    };
  }
  for (const l of LINES) if (!s.lines[l] || !Array.isArray(s.lines[l].techs)) s.lines[l] = { techs: [] };
  s.log = (Array.isArray(s.log) ? s.log : []).map((e, i) => (e.id ? e : { ...e, id: "old" + i + "-" + Date.parse(e.time) }));
  return s;
}

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

// Trims oldest completed history first; vehicles still in shop are never dropped.
function capLog(log) {
  if (log.length <= LOG_CAP) return log;
  let excess = log.length - LOG_CAP;
  return log.filter((e) => {
    if (excess > 0 && e.completedAt) {
      excess--;
      return false;
    }
    return true;
  });
}

function apply(state, action, payload = {}) {
  const s = JSON.parse(JSON.stringify(state));
  const line = LINES.includes(payload.line) ? payload.line : "main";
  const L = s.lines[line];
  const lname = LINE_NAMES[line];

  const dispatchTech = (tech, extra) => {
    const prevOrder = L.techs.map((t) => t.id);
    L.techs = [...L.techs.filter((t) => t.id !== tech.id), tech];
    const entry = {
      id: newId(),
      line,
      techId: tech.id,
      techName: tech.name,
      time: new Date().toISOString(),
      advisor: clean(payload.advisor, 20),
      ro: clean(payload.ro, 12),
      completedAt: null,
      prevOrder,
      ...extra,
    };
    s.log = capLog([...s.log, entry]);
    return entry;
  };

  switch (action) {
    case "dispatch": {
      const tech = L.techs.find((t) => !t.out);
      if (!tech) return { state: s, error: `No ${lname} techs available` };
      const e = dispatchTech(tech, {});
      return { state: s, message: `${lname} waiter dispatched to ${tech.name}${e.ro ? ` · RO ${e.ro}` : ""}`, dispatched: tech.name };
    }
    case "dispatchTo": {
      const tech = L.techs.find((t) => t.id === payload.id);
      if (!tech) return { state: s, error: "Tech not found" };
      if (tech.out) return { state: s, error: `${tech.name} is marked out — mark them in first` };
      const e = dispatchTech(tech, { direct: true, advisor: clean(payload.advisor, 20) || "Manager" });
      return { state: s, message: `Waiter dispatched directly to ${tech.name}${e.ro ? ` · RO ${e.ro}` : ""} — moved to back of line`, dispatched: tech.name };
    }
    case "skip": {
      const tech = L.techs.find((t) => !t.out);
      if (!tech) return { state: s, error: `No ${lname} techs available` };
      L.techs = [...L.techs.filter((t) => t.id !== tech.id), tech];
      return { state: s, message: `${tech.name} moved to back — no waiter logged` };
    }
    case "undo": {
      let idx = -1;
      for (let i = s.log.length - 1; i >= 0; i--) {
        if (s.log[i].line === line && !s.log[i].untracked) { idx = i; break; }
      }
      if (idx < 0) return { state: s, error: `Nothing to undo on ${lname}` };
      const last = s.log[idx];
      if (last.prevOrder) {
        const map = Object.fromEntries(L.techs.map((t) => [t.id, t]));
        const restored = last.prevOrder.map((id) => map[id]).filter(Boolean);
        L.techs.forEach((t) => { if (!last.prevOrder.includes(t.id)) restored.push(t); });
        L.techs = restored;
      }
      s.log.splice(idx, 1);
      return { state: s, message: `Undid ${lname} dispatch to ${last.techName}${last.ro ? ` · RO ${last.ro}` : ""}` };
    }
    case "complete": {
      const e = s.log.find((x) => x.id === payload.entryId);
      if (!e) return { state: s, error: "Vehicle not found — it may have been undone" };
      if (e.completedAt) return { state: s, error: `${e.techName}'s waiter is already completed` };
      e.completedAt = new Date().toISOString();
      e.completedBy = clean(payload.advisor, 20);
      const dur = fmtDur(Date.parse(e.completedAt) - Date.parse(e.time));
      return { state: s, message: `${e.techName}${e.ro ? ` · RO ${e.ro}` : ""} completed — ${dur} in shop` };
    }
    case "reopen": {
      const e = s.log.find((x) => x.id === payload.entryId);
      if (!e || !e.completedAt || e.untracked) return { state: s, error: "That vehicle can't be reopened" };
      e.completedAt = null;
      delete e.completedBy;
      return { state: s, message: `${e.techName}${e.ro ? ` · RO ${e.ro}` : ""} reopened — timer resumed from original drop-off` };
    }
    case "addTech": {
      const name = clean(payload.name, 30);
      if (!name) return { state: s, error: "Enter a tech name" };
      if (L.techs.some((t) => t.name.toLowerCase() === name.toLowerCase()))
        return { state: s, error: `${name} is already on ${lname}` };
      L.techs.push({ id: newId(), name, out: false });
      return { state: s, message: `${name} added to ${lname}` };
    }
    case "removeTech": {
      L.techs = L.techs.filter((t) => t.id !== payload.id);
      return { state: s };
    }
    case "toggleOut": {
      L.techs = L.techs.map((t) => (t.id === payload.id ? { ...t, out: !t.out } : t));
      return { state: s };
    }
    case "move": {
      const i = L.techs.findIndex((t) => t.id === payload.id);
      const j = i + (payload.dir === "up" ? -1 : 1);
      if (i < 0 || j < 0 || j >= L.techs.length) return { state: s };
      [L.techs[i], L.techs[j]] = [L.techs[j], L.techs[i]];
      return { state: s };
    }
    case "switchLine": {
      const other = line === "main" ? "express" : "main";
      const tech = L.techs.find((t) => t.id === payload.id);
      if (!tech) return { state: s, error: "Tech not found" };
      if (s.lines[other].techs.some((t) => t.name.toLowerCase() === tech.name.toLowerCase()))
        return { state: s, error: `${tech.name} is already on ${LINE_NAMES[other]}` };
      L.techs = L.techs.filter((t) => t.id !== tech.id);
      s.lines[other].techs.push(tech);
      return { state: s, message: `${tech.name} moved to ${LINE_NAMES[other]} (bottom of rotation)` };
    }
    case "clearLog": {
      s.log = s.log.filter((e) => e.line !== line || !e.completedAt);
      return { state: s, message: `${lname} completed history cleared — vehicles still in shop kept` };
    }
    default:
      return { state: s, error: "Unknown action" };
  }
}

export default async (req) => {
  const store = getStore("dispatch");
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

  const MANAGER_PIN = process.env.MANAGER_PIN || "8642";
  const ADVISOR_PIN = process.env.ADVISOR_PIN || "2468";
  const VIEW_PIN = process.env.VIEW_PIN || "1357";

  const roleFor = (pin) => {
    if (!pin) return null;
    if (pin === MANAGER_PIN) return "manager";
    if (pin === ADVISOR_PIN) return "advisor";
    if (pin === VIEW_PIN) return "view";
    return null;
  };

  const PERMS = {
    dispatch: ["advisor", "manager"],
    skip: ["advisor", "manager"],
    undo: ["advisor", "manager"],
    complete: ["advisor", "manager"],
    reopen: ["advisor", "manager"],
    dispatchTo: ["manager"],
    addTech: ["manager"],
    removeTech: ["manager"],
    toggleOut: ["manager"],
    move: ["manager"],
    switchLine: ["manager"],
    clearLog: ["manager"],
  };

  const read = async () => {
    const entry = await store.getWithMetadata(KEY);
    if (!entry || !entry.data) return { state: blank(), etag: null };
    let parsed = null;
    try { parsed = JSON.parse(entry.data); } catch {}
    return { state: migrate(parsed), etag: entry.etag || null };
  };

  if (req.method === "GET") {
    const role = roleFor(req.headers.get("x-pin"));
    if (!role) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
    const { state } = await read();
    return new Response(JSON.stringify({ state, role, serverTime: new Date().toISOString() }), { headers });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Bad request" }), { status: 400, headers });
    }

    if (body.action === "login") {
      const role = roleFor((body.payload && body.payload.pin) || "");
      if (!role) return new Response(JSON.stringify({ error: "Wrong PIN" }), { status: 401, headers });
      return new Response(JSON.stringify({ role }), { headers });
    }

    const role = roleFor(req.headers.get("x-pin"));
    const allowed = PERMS[body.action] || [];
    if (!role || !allowed.includes(role)) {
      let msg = "unauthorized";
      if (role === "view") msg = "View-only access — no dispatch permissions";
      else if (role === "advisor") msg = "Manager PIN required for that";
      return new Response(JSON.stringify({ error: msg }), { status: 401, headers });
    }

    let result = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      let current, etag;
      try {
        ({ state: current, etag } = await read());
      } catch {
        current = blank();
        etag = null;
      }
      result = apply(current, body.action, body.payload);
      if (result.error) break;

      result.state.lastUpdate = new Date().toISOString();
      const json = JSON.stringify(result.state);
      try {
        const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
        const wr = await store.set(KEY, json, opts);
        if (!wr || wr.modified !== false) break;
      } catch {
        await store.set(KEY, json);
        break;
      }
      if (attempt === 3) result = { error: "Board is busy — try again" };
    }
    return new Response(JSON.stringify(result), { headers });
  }

  return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
};

export const config = { path: "/api/board" };
