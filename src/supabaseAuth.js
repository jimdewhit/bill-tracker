import { supabase, isSyncConfigured } from "./supabaseClient.js";

export { isSyncConfigured };

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthStateChange(callback) {
  if (!supabase) return { unsubscribe() {} };
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange(callback);
  return subscription;
}

export async function signUpWithPassword(email, password) {
  if (!supabase) return { ok: false, error: "not-configured" };
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { ok: false, error: error.message };
  // With "Confirm email" enabled in the Supabase project (the default), sign-up
  // doesn't return a session until the confirmation code below is verified.
  return { ok: true, needsEmailConfirmation: !data.session };
}

// Verifies the 8-digit code from the "Confirm signup" email — the password
// equivalent of verifyLoginCode below, needed because that email's template
// was pointed at {{ .Token }} instead of a clickable {{ .ConfirmationURL }}
// link, for the same cross-shell reason described on sendLoginCode.
export async function verifySignupCode(email, token) {
  if (!supabase) return { ok: false, error: "not-configured" };
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "signup" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function signInWithPassword(email, password) {
  if (!supabase) return { ok: false, error: "not-configured" };
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Emails a one-time 8-digit code rather than a clickable magic link — a link
// would need to redirect back into this app, which has no single URL: it's a
// file:// window in Electron, a WebView origin in the Android build, and a
// real URL only in the Docker/web build. A typed code works identically
// across all three with no platform-specific deep-link wiring. Requires the
// "Magic Link" email template in the Supabase dashboard to include
// {{ .Token }} (it only shows {{ .ConfirmationURL }} by default).
export async function sendLoginCode(email) {
  if (!supabase) return { ok: false, error: "not-configured" };
  const { error } = await supabase.auth.signInWithOtp({ email });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function verifyLoginCode(email, token) {
  if (!supabase) return { ok: false, error: "not-configured" };
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

// Emails an 8-digit recovery code — same reasoning as sendLoginCode above.
// Requires the "Reset Password" email template in the Supabase dashboard to
// include {{ .Token }}.
export async function sendPasswordResetCode(email) {
  if (!supabase) return { ok: false, error: "not-configured" };
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// Verifying the recovery code signs the user in (proves email ownership) —
// updatePassword below then sets the new password on that session.
export async function verifyPasswordResetCode(email, token) {
  if (!supabase) return { ok: false, error: "not-configured" };
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "recovery" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function updatePassword(newPassword) {
  if (!supabase) return { ok: false, error: "not-configured" };
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
