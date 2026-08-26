// Compatibilidade temporaria para imports antigos da API.
// O provedor e o transporte agora sao Neon Data API; nao existe SDK Supabase aqui.
export {
  getDatabaseAdmin as getSupabaseAdmin,
  getSecurityDatabaseAdmin as getSecuritySupabaseAdmin,
} from "./database.js";
