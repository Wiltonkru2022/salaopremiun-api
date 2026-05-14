import { config } from "../config.js";
import { sendResendEmail } from "./resend.js";
import { appendNdjson, createJob, files } from "./store.js";
import { getSupabaseAdmin } from "./supabase.js";

type AnyRecord = Record<string, unknown>;

type TrialAlertType = "3d" | "1d" | "today" | "expired" | "manual" | "upgrade";

type AssinaturaTrialRow = {
  id?: string | null;
  id_salao?: string | null;
  plano?: string | null;
  status?: string | null;
  trial_fim_em?: string | null;
  email_trial_3d_sent_at?: string | null;
  email_trial_1d_sent_at?: string | null;
  email_trial_today_sent_at?: string | null;
  email_trial_expired_sent_at?: string | null;
};

type SalaoTrialRow = {
  id: string;
  nome?: string | null;
  nome_fantasia?: string | null;
  responsavel?: string | null;
  email?: string | null;
  whatsapp?: string | null;
  telefone?: string | null;
  status?: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function getAdminClient() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    const error = new Error("Supabase da VPS nao configurado.");
    (error as Error & { statusCode?: number }).statusCode = 503;
    throw error;
  }
  return supabase;
}

function throwIfSupabaseError(error: { message?: string } | null, label: string) {
  if (!error) return;
  const err = new Error(`${label}: ${error.message || "erro desconhecido"}`);
  (err as Error & { statusCode?: number }).statusCode = 502;
  throw err;
}

function daysUntil(value?: string | null) {
  if (!value) return null;
  const end = new Date(value);
  if (Number.isNaN(end.getTime())) return null;
  return Math.ceil((end.getTime() - Date.now()) / DAY_MS);
}

function sentColumnForType(type: TrialAlertType) {
  if (type === "3d") return "email_trial_3d_sent_at";
  if (type === "1d") return "email_trial_1d_sent_at";
  if (type === "today") return "email_trial_today_sent_at";
  if (type === "expired") return "email_trial_expired_sent_at";
  return null;
}

function alertTypeFromDays(daysLeft: number | null): TrialAlertType | null {
  if (daysLeft === 3) return "3d";
  if (daysLeft === 1) return "1d";
  if (daysLeft === 0) return "today";
  if (daysLeft !== null && daysLeft < 0) return "expired";
  return null;
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

function salaoName(salao: SalaoTrialRow | null) {
  return String(salao?.nome_fantasia || salao?.nome || "seu salao").trim();
}

function normalizePhone(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55")) return digits;
  return `55${digits}`;
}

function buildEmail(params: {
  type: TrialAlertType;
  salao: SalaoTrialRow | null;
  assinatura: AssinaturaTrialRow;
}) {
  const nomeSalao = salaoName(params.salao);
  const trialFim = formatDate(params.assinatura.trial_fim_em);
  const painelUrl = config.appBaseUrl;
  const whatsapp = normalizePhone(params.salao?.whatsapp || params.salao?.telefone) || config.supportWhatsapp;

  const messages: Record<TrialAlertType, { subject: string; title: string; body: string }> = {
    "3d": {
      subject: "Seu teste gratis do SalaoPremium esta terminando",
      title: "Seu teste gratis termina em 3 dias",
      body:
        "Seu periodo de teste gratis no SalaoPremium esta chegando ao fim. Voce ainda pode continuar usando agenda, clientes, atendimentos, caixa e notificacoes do seu salao.",
    },
    "1d": {
      subject: "Amanha termina seu teste gratis do SalaoPremium",
      title: "Seu teste gratis termina amanha",
      body:
        "Amanha e o ultimo dia do seu teste gratis. Se quiser continuar, podemos ajudar na ativacao do plano ou liberar mais alguns dias para testar com calma.",
    },
    today: {
      subject: "Hoje e o ultimo dia do seu teste gratis",
      title: "Hoje e o ultimo dia do seu teste gratis",
      body:
        "Hoje e o ultimo dia do seu periodo de teste gratis no SalaoPremium. Estamos por aqui para ajudar com a ativacao do plano.",
    },
    expired: {
      subject: "Seu teste gratis do SalaoPremium venceu",
      title: "Seu teste gratis venceu",
      body:
        "Seu periodo de teste gratis venceu. Para continuar usando todos os recursos, ative um plano ou fale com o suporte para avaliar uma prorrogacao.",
    },
    manual: {
      subject: "Aviso sobre seu teste gratis do SalaoPremium",
      title: "Vamos cuidar do seu teste gratis",
      body:
        "Passando para acompanhar seu periodo de teste no SalaoPremium. Se precisar de ajuda, ativacao do plano ou mais alguns dias, responda este e-mail.",
    },
    upgrade: {
      subject: "Ative seu plano no SalaoPremium",
      title: "Continue usando o SalaoPremium",
      body:
        "Seu salao ja pode continuar com o SalaoPremium em producao. Podemos ajudar na escolha do plano e na ativacao para manter sua operacao funcionando.",
    },
  };

  const selected = messages[params.type] || messages.manual;
  const text = `${selected.title}\n\nOla, ${nomeSalao}.\n\n${selected.body}\n\nVencimento do teste: ${trialFim}\nPainel: ${painelUrl}\nWhatsApp: https://wa.me/${whatsapp}\n\nEquipe SalaoPremium`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;background:#f6f7f9;padding:28px;color:#18181b">
      <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:22px;padding:28px;border:1px solid #e4e4e7">
        <p style="font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#a16207;margin:0 0 12px">SalaoPremium</p>
        <h1 style="font-size:28px;line-height:1.1;margin:0 0 14px;color:#09090b">${selected.title}</h1>
        <p style="font-size:16px;line-height:1.7;margin:0 0 16px">Ola, <strong>${nomeSalao}</strong>.</p>
        <p style="font-size:16px;line-height:1.7;margin:0 0 16px">${selected.body}</p>
        <div style="background:#fafafa;border:1px solid #e4e4e7;border-radius:16px;padding:16px;margin:22px 0">
          <p style="margin:0 0 8px"><strong>Vencimento do teste:</strong> ${trialFim}</p>
          <p style="margin:0"><strong>Suporte:</strong> WhatsApp ${whatsapp}</p>
        </div>
        <a href="${painelUrl}" style="display:inline-block;background:#09090b;color:#fff;text-decoration:none;border-radius:999px;padding:13px 20px;font-weight:800">Acessar painel</a>
        <a href="https://wa.me/${whatsapp}" style="display:inline-block;margin-left:8px;color:#09090b;text-decoration:none;border:1px solid #d4d4d8;border-radius:999px;padding:12px 18px;font-weight:800">Falar no WhatsApp</a>
        <p style="font-size:13px;line-height:1.6;color:#71717a;margin:24px 0 0">Se voce precisar de mais alguns dias para testar com calma, responda este e-mail.</p>
      </div>
    </div>
  `;

  return { subject: selected.subject, html, text };
}

async function loadSalaoMap(ids: string[]) {
  if (!ids.length) return new Map<string, SalaoTrialRow>();
  const { data, error } = await getAdminClient()
    .from("saloes")
    .select("id,nome,nome_fantasia,responsavel,email,whatsapp,telefone,status")
    .in("id", ids);

  throwIfSupabaseError(error, "Falha ao carregar saloes para aviso de trial");

  return new Map(
    ((data || []) as SalaoTrialRow[]).map((salao) => [String(salao.id), salao]),
  );
}

async function sendTrialAlertEmail(params: {
  type: TrialAlertType;
  assinatura: AssinaturaTrialRow;
  salao: SalaoTrialRow | null;
  markSent?: boolean;
}) {
  const email = String(params.salao?.email || "").trim().toLowerCase();
  if (!email) {
    throw new Error("Salao sem e-mail para aviso de trial.");
  }

  const content = buildEmail(params);
  const result = await sendResendEmail({
    to: email,
    subject: content.subject,
    html: content.html,
    text: content.text,
  });

  const column = sentColumnForType(params.type);
  if (params.markSent && column && params.assinatura.id_salao) {
    const { error } = await getAdminClient()
      .from("assinaturas")
      .update({ [column]: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id_salao", params.assinatura.id_salao);
    throwIfSupabaseError(error, "Falha ao marcar aviso de trial como enviado");
  }

  appendNdjson(files.notifications, {
    type: "trial:email",
    status: "sent",
    alert_type: params.type,
    id_salao: params.assinatura.id_salao || null,
    to: email,
    resend: result,
  });

  return { ok: true, to: email, type: params.type, resend: result };
}

export async function processTrialAlerts(payload?: AnyRecord) {
  const limit = Math.min(Number(payload?.limit || 80), 150);
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("assinaturas")
    .select(
      "id,id_salao,plano,status,trial_fim_em,email_trial_3d_sent_at,email_trial_1d_sent_at,email_trial_today_sent_at,email_trial_expired_sent_at",
    )
    .not("trial_fim_em", "is", null)
    .in("status", ["teste_gratis", "trial", "trialing", "ativa"])
    .order("trial_fim_em", { ascending: true })
    .limit(limit);

  throwIfSupabaseError(error, "Falha ao carregar assinaturas em trial");

  const rows = (data || []) as AssinaturaTrialRow[];
  const saloes = await loadSalaoMap(
    rows.map((row) => String(row.id_salao || "")).filter(Boolean),
  );
  const stats = { scanned: rows.length, sent: 0, skipped: 0, failed: 0 };
  const errors: Array<{ id_salao: string | null; error: string }> = [];

  for (const row of rows) {
    const daysLeft = daysUntil(row.trial_fim_em);
    const type = alertTypeFromDays(daysLeft);
    const column = type ? sentColumnForType(type) : null;

    if (!type || !column || row[column as keyof AssinaturaTrialRow]) {
      stats.skipped += 1;
      continue;
    }

    try {
      await sendTrialAlertEmail({
        type,
        assinatura: row,
        salao: saloes.get(String(row.id_salao || "")) || null,
        markSent: true,
      });
      stats.sent += 1;
    } catch (errorItem) {
      stats.failed += 1;
      errors.push({
        id_salao: row.id_salao || null,
        error: errorItem instanceof Error ? errorItem.message : "Falha ao enviar aviso.",
      });
    }
  }

  const job = createJob("trial-alerts:process", { requested: payload || null, stats, errors }, "completed");
  return { ok: true, service: config.serviceName, job, ...stats, errors };
}

export async function sendTrialAlertNow(payload: AnyRecord) {
  const idSalao = String(payload.id_salao || payload.idSalao || "").trim();
  const type = String(payload.type || payload.tipo || "manual").trim() as TrialAlertType;
  if (!idSalao) {
    const error = new Error("id_salao e obrigatorio para enviar aviso de trial.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  const supabase = getAdminClient();
  const [{ data: assinatura, error: assinaturaError }, { data: salao, error: salaoError }] = await Promise.all([
    supabase
      .from("assinaturas")
      .select("id,id_salao,plano,status,trial_fim_em,email_trial_3d_sent_at,email_trial_1d_sent_at,email_trial_today_sent_at,email_trial_expired_sent_at")
      .eq("id_salao", idSalao)
      .maybeSingle(),
    supabase
      .from("saloes")
      .select("id,nome,nome_fantasia,responsavel,email,whatsapp,telefone,status")
      .eq("id", idSalao)
      .maybeSingle(),
  ]);

  throwIfSupabaseError(assinaturaError, "Falha ao carregar assinatura para aviso");
  throwIfSupabaseError(salaoError, "Falha ao carregar salao para aviso");

  if (!assinatura) {
    const error = new Error("Assinatura nao encontrada para este salao.");
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }

  const result = await sendTrialAlertEmail({
    type: ["3d", "1d", "today", "expired", "upgrade"].includes(type) ? type : "manual",
    assinatura: assinatura as AssinaturaTrialRow,
    salao: (salao || null) as SalaoTrialRow | null,
    markSent: Boolean(payload.markSent),
  });
  const job = createJob("trial-alerts:send-now", { id_salao: idSalao, type, result }, "completed");
  return { ok: true, service: config.serviceName, job, result };
}

export async function extendTrial(payload: AnyRecord) {
  const idSalao = String(payload.id_salao || payload.idSalao || "").trim();
  const days = Math.min(Math.max(Number(payload.days || payload.dias || 3), 1), 30);
  if (!idSalao) {
    const error = new Error("id_salao e obrigatorio para prorrogar trial.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  const supabase = getAdminClient();
  const now = new Date();
  const base = payload.currentTrialEndsAt ? new Date(String(payload.currentTrialEndsAt)) : now;
  const validBase = Number.isNaN(base.getTime()) || base.getTime() < now.getTime() ? now : base;
  const newEnd = new Date(validBase.getTime() + days * DAY_MS).toISOString();
  const updatePayload = {
    plano: "teste_gratis",
    status: "teste_gratis",
    trial_ativo: true,
    trial_fim_em: newEnd,
    email_trial_3d_sent_at: null,
    email_trial_1d_sent_at: null,
    email_trial_today_sent_at: null,
    email_trial_expired_sent_at: null,
    updated_at: now.toISOString(),
  };

  const { error: assinaturaError } = await supabase
    .from("assinaturas")
    .update(updatePayload)
    .eq("id_salao", idSalao);
  throwIfSupabaseError(assinaturaError, "Falha ao prorrogar trial na assinatura");

  const { error: salaoError } = await supabase
    .from("saloes")
    .update({ plano: "teste_gratis", trial_ativo: true, trial_fim_em: newEnd, updated_at: now.toISOString() })
    .eq("id", idSalao);
  throwIfSupabaseError(salaoError, "Falha ao prorrogar trial no salao");

  const job = createJob(
    "trial-alerts:extend",
    {
      id_salao: idSalao,
      days,
      trial_fim_em: newEnd,
      reason: payload.reason || payload.motivo || null,
      source: payload.source || null,
    },
    "completed",
  );
  return { ok: true, service: config.serviceName, job, trial_fim_em: newEnd };
}
