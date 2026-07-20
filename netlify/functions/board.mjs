import { getStore } from "@netlify/blobs";

const KEY = "board-state";
const emptyState = { techs: [], log: [], lastUpdate: null };

async function loadState(store) {
  const raw = await store.get(KEY);
  if (!raw) return { ...emptyState };
  try {
    return JSON.parse(raw);
  } catch {
    return { ...emptyState };
  }
}

function apply(state, action, payload = {}) {
  const s = {
    techs: [...state.techs.map((t) => ({ ...t }))],
    log: [...state.log],
    lastUpdate: state.lastUpdate,
  };

  switch (action) {
    case "dispatch": {
      const active = s.techs.filter((t) => !t.out);
      if (active.length === 0) return { state: s, error: "No techs available" };
      const tech = active[0];
      const prevOrder = s.techs.map((t) => t.id);
      s.techs = [...s.techs.filter((t) => t.id !== tech.id), tech];
      s.log = [
        ...s.log,
        {
          techId: tech.id,
          techName: tech.name,
          time: new Date().toISOString(),
          advisor: (payload.advisor || "").trim().slice(0, 20) || null,
          prevOrder,
        },
      ].slice(-300);
      return { state: s, message: `Waiter dispatched to ${tech.name}`, dispatched: tech.name };
    }
    case "skip": {
      const active = s.techs.filter((t) => !t.out);
      if (active.length === 0) return { state: s, error: "No techs available" };
      const tech = active[0];
      s.techs = [...s.techs.filter((t) => t.id !== tech.id), tech];
      return { state: s, message: `${tech.name} moved to back — no waiter logged` };
    }
    case "undo": {
      if (s.log.length === 0) return { state: s, error: "Nothing to undo" };
      const last = s.log[s.log.length - 1];
      if (last.prevOrder) {
        const map = Object.fromEntries(s.techs.map((t) => [t.id, t]));
        const restored = last.prevOrder.map((id) => map[id]).filter(Boolean);
        s.techs.forEach((t) => {
          if (!last.prevOrder.includes(t.id)) restored.push(t);
        });
        s.techs = restored;
      }
      s.log = s.log.slice(0, -1);
      return { state: s, message: `Undid dispatch to ${last.techName}` };
    }
    case "addTech": {
      const name = (payload.name || "").trim().slice(0, 30);
      if (!name) return { state: s, error: "Enter a tech name" };
      if (s.techs.some((t) => t.name.toLowerCase() === name.toLowerCase()))
        return { state: s, error: `${name} is already on the board` };
      s.techs = [...s.techs, { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, out: false }];
      return { state: s, message: `${name} added` };
    }
    case "removeTech": {
      s.techs = s.techs.filter((t) => t.id !== payload.id);
      return { state: s };
    }
    case "toggleOut": {
      s.techs = s.techs.map((t) => (t.id === payload.id ? { ...t, out: !t.out } : t));
      return { state: s };
    }
    case "move": {
      const i = s.techs.findIndex((t) => t.id === payload.id);
      const j = i + (payload.dir === "up" ? -1 : 1);
      if (i < 0 || j < 0 || j >= s.techs.length) return { state: s };
      const arr = [...s.techs];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      s.techs = arr;
      return { state: s };
    }
    case "clearLog": {
      s.log = [];
      return { state: s, message: "Dispatch log cleared" };
    }
    default:
      return { state: s, error: "Unknown action" };
  }
}

export default async (req) => {
  const store = getStore("dispatch");
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

  const ADVISOR_PIN = process.env.ADVISOR_PIN || "2468";
  const VIEW_PIN = process.env.VIEW_PIN || "1357";

  const roleFor = (pin) => {
    if (!pin) return null;
    if (pin === ADVISOR_PIN) return "advisor";
    if (pin === VIEW_PIN) return "view";
    return null;
  };

  if (req.method === "GET") {
    const role = roleFor(req.headers.get("x-pin"));
    if (!role) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
    }
    const state = await loadState(store);
    return new Response(JSON.stringify({ state, role }), { headers });
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
      if (!role) {
        return new Response(JSON.stringify({ error: "Wrong PIN" }), { status: 401, headers });
      }
      return new Response(JSON.stringify({ role }), { headers });
    }

    const role = roleFor(req.headers.get("x-pin"));
    if (role !== "advisor") {
      return new Response(
        JSON.stringify({ error: role === "view" ? "View-only access — advisor PIN required for that" : "unauthorized" }),
        { status: 401, headers }
      );
    }

    let result = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      let current = { ...emptyState };
      let etag = null;
      try {
        const entry = await store.getWithMetadata(KEY);
        if (entry && entry.data) {
          current = JSON.parse(entry.data);
          etag = entry.etag || null;
        }
      } catch {}

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
