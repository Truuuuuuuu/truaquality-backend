import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set");
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey);
