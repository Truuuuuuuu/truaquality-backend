import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set");
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey);

// Uses a throwaway, non-persisting client so the session a successful check creates never lands on the
// shared client above.
export async function verifyPassword(userId: string, email: string, password: string) {
  const client = createClient(supabaseUrl!, supabasePublishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  return !error && data.user?.id === userId;
}
