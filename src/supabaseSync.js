const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSyncConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const REST_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1/sync_blobs` : null;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// Upsert this device's current data under syncKey. Never throws — callers
// get {ok:false, error} on any failure (network, RLS reject, bad key) so a
// sync hiccup can never surface as an uncaught error or block local saves.
export async function pushBlob(syncKey, dataObj) {
  if (!isSyncConfigured) return { ok: false, error: "not-configured" };
  try {
    const res = await fetch(REST_URL, {
      method: "POST",
      headers: headers({ Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify([{ sync_key: syncKey, data: dataObj, updated_at: new Date().toISOString() }]),
    });
    if (!res.ok) return { ok: false, error: `http-${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || "network-error" };
  }
}

// Fetch the cloud row for syncKey. exists:false means no row yet (first
// pairing) — caller should seed the cloud from local data in that case.
// ok:false means the fetch itself failed (offline, invalid key, etc.) —
// caller should leave local data untouched.
export async function pullBlob(syncKey) {
  if (!isSyncConfigured) return { ok: false, error: "not-configured" };
  try {
    const url = `${REST_URL}?sync_key=eq.${encodeURIComponent(syncKey)}&select=data,updated_at`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return { ok: false, error: `http-${res.status}` };
    const rows = await res.json();
    if (!rows.length) return { ok: true, exists: false };
    return { ok: true, exists: true, data: rows[0].data, updatedAt: rows[0].updated_at };
  } catch (e) {
    return { ok: false, error: e.message || "network-error" };
  }
}

// RFC4122-ish v4 UUID via crypto.getRandomValues rather than
// crypto.randomUUID(), which requires a "secure context" whose availability
// varies across this app's three shells (Electron file:// window, Capacitor's
// Android WebView, plain https preview) — getRandomValues is universally
// supported and avoids a silent runtime crash on whichever shell lacks it.
export function generateSyncKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function looksLikeSyncKey(s) {
  return typeof s === "string" && UUID_RE.test(s.trim());
}
