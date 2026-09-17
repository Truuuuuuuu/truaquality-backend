import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set");
}

// This client is module-scoped and shared by every request (login's signInWithPassword, requireAuth's
// getClaims). In a Node process there's no window.localStorage, so the default persistSession: true
// falls back to an in-memory store *on this one shared instance* — meaning one request's login would
// otherwise overwrite another concurrent request's session in that shared in-memory state, and could
// start a background autoRefreshToken timer for whichever session landed there last. Neither call this
// client makes needs its own persisted session (login returns the session in the HTTP response either
// way; getClaims verifies a caller-supplied JWT), so both are disabled.
export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Uses a throwaway, non-persisting client so the session a successful check creates never lands on the
// shared client above.
export async function verifyPassword(userId: string, email: string, password: string) {
  const client = createClient(supabaseUrl!, supabasePublishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  const verified = !error && data.user?.id === userId;
  // persistSession: false only stops this client from writing the session to storage — Supabase's Auth
  // server still issued a real, live access/refresh token pair for signing in. Without this, that
  // session sits unrevoked in Supabase until it expires on its own timer; the caller (DELETE /me)
  // normally deletes the whole account right after, which takes every session with it, but not on its
  // own failure path (e.g. a transient error from the deleteUser call), where this would otherwise be
  // the only trace of an untracked, never-shown-to-the-user session left on the account.
  if (!error) {
    await client.auth.signOut();
  }
  return verified;
}
