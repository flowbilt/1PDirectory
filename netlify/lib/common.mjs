import { getStore } from "@netlify/blobs";

export const SITE_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** The old editor's storage. Only read now, by the one-time import (/api/migrate). */
export function store() {
  return getStore({ name: "directory", consistency: "strong" });
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
