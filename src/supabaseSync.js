import { supabase, isSyncConfigured } from "./supabaseClient.js";

export { isSyncConfigured };

const TABLE = "account_blobs";

// Upsert this account's current data. Never throws — callers get
// {ok:false, error} on any failure (network, RLS reject, not signed in) so a
// sync hiccup can never surface as an uncaught error or block local saves.
export async function pushBlob(userId, dataObj) {
  if (!supabase) return { ok: false, error: "not-configured" };
  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert({ user_id: userId, data: dataObj, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || "network-error" };
  }
}

// Fetch the cloud row for this account. exists:false means no row yet (first
// sign-in on any device) — caller should seed the cloud from local data in
// that case. ok:false means the fetch itself failed (offline, RLS reject,
// etc.) — caller should leave local data untouched.
export async function pullBlob(userId) {
  if (!supabase) return { ok: false, error: "not-configured" };
  try {
    const { data: rows, error } = await supabase
      .from(TABLE)
      .select("data,updated_at")
      .eq("user_id", userId)
      .limit(1);
    if (error) return { ok: false, error: error.message };
    if (!rows.length) return { ok: true, exists: false };
    return { ok: true, exists: true, data: rows[0].data, updatedAt: rows[0].updated_at };
  } catch (e) {
    return { ok: false, error: e.message || "network-error" };
  }
}
