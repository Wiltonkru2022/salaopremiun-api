export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "0.0.0.0",
  serviceName: process.env.SERVICE_NAME || "salaopremiun-api",
  version: process.env.APP_VERSION || "0.1.0",
  apiAdminToken: process.env.API_ADMIN_TOKEN || "",
  apiSecret: process.env.API_SECRET || "",
  professionalJwtSecret:
    process.env.PROFESSIONAL_JWT_SECRET ||
    process.env.API_SECRET ||
    process.env.API_ADMIN_TOKEN ||
    "",
  professionalRefreshSecret:
    process.env.PROFESSIONAL_REFRESH_SECRET ||
    process.env.PROFESSIONAL_JWT_SECRET ||
    process.env.API_SECRET ||
    process.env.API_ADMIN_TOKEN ||
    "",
  cronSecret: process.env.CRON_SECRET || "",
  dataDir: process.env.DATA_DIR || "./data",
  maxNdjsonLines: Number(process.env.MAX_NDJSON_LINES || 500),
  retentionDays: Number(process.env.RETENTION_DAYS || 7),
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  securitySupabaseUrl: process.env.SECURITY_SUPABASE_URL || "",
  securitySupabaseServiceRoleKey:
    process.env.SECURITY_SUPABASE_SERVICE_ROLE_KEY || "",
  securityEventsTable: process.env.SECURITY_EVENTS_TABLE || "security_events",
  asaasApiKey: process.env.ASAAS_API_KEY || "",
  asaasWebhookToken: process.env.ASAAS_WEBHOOK_TOKEN || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  trialAlertEmailFrom:
    process.env.TRIAL_ALERT_EMAIL_FROM ||
    process.env.CADASTRO_SALAO_EMAIL_FROM ||
    "SalaoPremium <boasvindas@salaopremiun.com.br>",
  appBaseUrl: process.env.APP_BASE_URL || "https://painel.salaopremiun.com.br",
  supportWhatsapp: process.env.SUPPORT_WHATSAPP || "5567984341742",
  webPushPrivateKey:
    process.env.WEB_PUSH_PRIVATE_KEY || process.env.WEB_PUSH_VAPID_PRIVATE_KEY || "",
  webPushPublicKey:
    process.env.WEB_PUSH_PUBLIC_KEY ||
    process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY ||
    "",
};
