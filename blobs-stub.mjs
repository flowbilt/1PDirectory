// In-memory stand-in for @netlify/blobs, used only by tests and the local test server.
const stores = new Map();
export function getStore(opts) {
  const name = typeof opts === "string" ? opts : opts.name;
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name);
  return {
    async get(key, o = {}) { if (!m.has(key)) return null; const v = m.get(key); return o.type === "json" ? JSON.parse(v) : v; },
    async setJSON(key, v) { m.set(key, JSON.stringify(v)); },
    async set(key, v) { m.set(key, String(v)); },
    async delete(key) { m.delete(key); },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
export function _reset() { stores.clear(); }
