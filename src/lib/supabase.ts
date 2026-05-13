import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { config } from "../config.js";

export function getSupabaseAdmin() {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    return null;
  }

  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: WebSocket as any,
    },
  });
}