import webPush from "web-push";
import { config } from "../config.js";
import { getSupabaseAdmin } from "./supabase.js";

type PushAudience = "cliente_app" | "profissional_app" | "salao_painel";

type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  cliente_app_conta_id?: string | null;
};

type NotificationJobRow = {
  id: string;
  id_salao: string | null;
  id_cliente: string | null;
  id_profissional: string | null;
  cliente_app_conta_id: string | null;
  canal: PushAudience;
  tipo: string;
  titulo: string;
  mensagem: string;
  url: string | null;
  tag: string | null;
  status: string;
  enviar_em: string;
  tentativas: number | null;
  idempotency_key?: string | null;
};

type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag?: string | null;
};

function hasPushConfig() {
  return Boolean(config.webPushPublicKey && config.webPushPrivateKey);
}

function setupWebPush() {
  if (!hasPushConfig()) return false;
  webPush.setVapidDetails(
    "mailto:suporte@salaopremiun.com.br",
    config.webPushPublicKey,
    config.webPushPrivateKey,
  );
  return true;
}

async function markSubscriptionInactive(id: string) {
  await getSupabaseAdmin()
    ?.from("push_subscriptions")
    .update({ ativo: false, updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function isClienteAppPushEnabled(clienteAppContaId?: string | null) {
  const id = String(clienteAppContaId || "").trim();
  if (!id) return false;

  const { data, error } = await getSupabaseAdmin()!
    .from("clientes_app_auth")
    .select("notificacoes_ativas, notificacao_app_ativa")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    const message = String(error.message || "");
    if (message.includes("notificacoes_ativas") || message.includes("notificacao_app_ativa")) {
      return true;
    }
    return false;
  }

  const row = data as { notificacoes_ativas?: boolean | null; notificacao_app_ativa?: boolean | null } | null;
  if (!row) return false;
  return row.notificacoes_ativas !== false && row.notificacao_app_ativa !== false;
}

export async function findSubscriptionsForNotification(job: NotificationJobRow) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return [];

  let query = supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth, cliente_app_conta_id")
    .eq("ativo", true)
    .eq("audience", job.canal);

  if (job.canal === "cliente_app") {
    if (!job.cliente_app_conta_id) return [];
    const enabled = await isClienteAppPushEnabled(job.cliente_app_conta_id);
    if (!enabled) return [];
    query = query.eq("cliente_app_conta_id", job.cliente_app_conta_id);
  }

  if (job.canal === "profissional_app") {
    if (!job.id_salao || !job.id_profissional) return [];
    query = query.eq("id_salao", job.id_salao).eq("id_profissional", job.id_profissional);
  }

  if (job.canal === "salao_painel") {
    if (!job.id_salao) return [];
    query = query.eq("id_salao", job.id_salao);
  }

  const { data, error } = await query.limit(1000);
  if (error || !data?.length) return [];
  return data as PushSubscriptionRow[];
}

export async function sendPushToRows(rows: PushSubscriptionRow[], payload: PushPayload) {
  if (!rows.length || !setupWebPush()) return { sent: 0, failed: rows.length, inactive: 0 };

  const uniqueRows = Array.from(new Map(rows.map((row) => [row.endpoint, row])).values());
  let sent = 0;
  let failed = 0;
  let inactive = 0;

  await Promise.all(
    uniqueRows.map(async (row) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          JSON.stringify({
            title: payload.title,
            body: payload.body,
            url: payload.url,
            tag: payload.tag || "salaopremiun",
            renotify: false,
            requireInteraction: false,
            silent: false,
            timestamp: Date.now(),
          }),
          { TTL: 60 * 60 * 12 },
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error
            ? Number((error as { statusCode?: unknown }).statusCode)
            : 0;
        if (statusCode === 404 || statusCode === 410) {
          inactive += 1;
          await markSubscriptionInactive(row.id);
        }
      }
    }),
  );

  return { sent, failed, inactive };
}

export type { NotificationJobRow };
