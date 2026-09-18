import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSyncConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Only constructed when both env vars are present — every caller checks
// isSyncConfigured (or that this is non-null) before touching it.
export const supabase = isSyncConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
