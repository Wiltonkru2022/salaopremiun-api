import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import {
  bearerTokenFromRequest,
  createProfessionalToken,
  requireProfessionalAuth,
  verifyProfessionalToken,
  type ProfessionalAuthContext,
} from "../lib/professionalJwt.js";
import { getSupabaseAdmin } from "../lib/supabase.js";

type AnyRecord = Record<string, unknown>;

const ACCESS_TOKEN_SECONDS = 60 * 30;
const REFRESH_TOKEN_SECONDS = 60 * 60 * 24 * 30;

function getAdminClient() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    const error = new Error("Supabase da VPS não configurado.");
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

function text(value: unknown, maxLength = 300) {
  return String(value || "").trim().slice(0, maxLength);
}

function numberValue(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cents(value: unknown) {
  return { cents: Math.round(numberValue(value) * 100) };
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function nested(value: unknown) {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function pageFromQuery(query: AnyRecord) {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 50);
  const from = (page - 1) * limit;
  return { page, limit, from, to: from + limit - 1 };
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthStart() {
  const today = todayDate();
  return `${today.slice(0, 8)}01`;
}

function buildTokens(profile: { id: string; idSalao: string; nome: string }) {
  return {
    accessToken: createProfessionalToken({
      idProfissional: profile.id,
      idSalao: profile.idSalao,
      nome: profile.nome,
      tokenType: "access",
      expiresInSeconds: ACCESS_TOKEN_SECONDS,
    }),
    refreshToken: createProfessionalToken({
      idProfissional: profile.id,
      idSalao: profile.idSalao,
      nome: profile.nome,
      tokenType: "refresh",
      expiresInSeconds: REFRESH_TOKEN_SECONDS,
    }),
  };
}

function statusToAppointmentStatus(status: unknown) {
  const normalized = text(status).toLowerCase();
  if (["confirmado", "confirmada", "confirmed"].includes(normalized)) return "Confirmed";
  if (["em_atendimento", "em atendimento", "in_progress"].includes(normalized)) return "InProgress";
  if (["reservado_aguardando_pagamento", "aguardando_pagamento"].includes(normalized)) {
    return "WaitingPayment";
  }
  return "PendingConfirmation";
}

function statusToCommandStatus(status: unknown) {
  const normalized = text(status).toLowerCase();
  if (["fechada", "fechado", "closed"].includes(normalized)) return "Closed";
  if (["cancelada", "cancelado", "canceled"].includes(normalized)) return "Canceled";
  if (["enviada_caixa", "enviado_caixa", "enviada ao caixa"].includes(normalized)) return "SentToCashier";
  return "Open";
}

function statusToCommissionStatus(status: unknown) {
  const normalized = text(status).toLowerCase();
  return ["paga", "pago", "paid"].includes(normalized) ? "Paid" : "Pending";
}

function timeRange(item: AnyRecord) {
  const start = text(item.hora_inicio).slice(0, 5);
  const end = text(item.hora_fim).slice(0, 5);
  return start && end ? `${start} - ${end}` : start || "--:--";
}

function appointmentPreview(item: AnyRecord, fallbackProfessionalName: string) {
  const cliente = nested(item.clientes);
  const servico = nested(item.servicos);
  const profissional = nested(item.profissionais);
  return {
    id: text(item.id),
    timeRange: timeRange(item),
    clientName: text(cliente.nome, 140) || "Cliente não informado",
    serviceName: text(servico.nome, 140) || "Serviço não informado",
    professionalName:
      text(profissional.nome_exibicao, 140) ||
      text(profissional.nome, 140) ||
      fallbackProfessionalName,
    status: statusToAppointmentStatus(item.status),
  };
}

function clientSummary(item: AnyRecord) {
  return {
    id: text(item.id),
    name: text(item.nome, 140) || "Cliente",
    phone: text(item.telefone || item.whatsapp || item.celular, 40),
    email: text(item.email, 180),
    lastVisit: text(item.ultimo_atendimento || item.updated_at || item.created_at).slice(0, 10),
  };
}

async function loadProfile(idProfissional: string, idSalao?: string) {
  const supabase = getAdminClient();
  let query = supabase
    .from("profissionais")
    .select("id,nome,nome_exibicao,email,telefone,ativo,status,id_salao,tipo_profissional,saloes(id,nome,status)")
    .eq("id", idProfissional)
    .limit(1);

  if (idSalao) query = query.eq("id_salao", idSalao);

  const result = await query.maybeSingle();
  throwIfSupabaseError(result.error, "Falha ao carregar profissional");
  const profissional = asRecord(result.data);
  if (!profissional.id) return null;

  const salao = nested(profissional.saloes);
  return {
    id: text(profissional.id),
    name: text(profissional.nome_exibicao || profissional.nome, 140),
    salonId: text(profissional.id_salao),
    salonName: text(salao.nome, 140) || "SalaoPremiun",
    email: text(profissional.email, 180),
    phone: text(profissional.telefone, 40),
    active: profissional.ativo !== false && text(profissional.status).toLowerCase() !== "inativo",
  };
}

async function requireCurrentProfile(auth: ProfessionalAuthContext) {
  const profile = await loadProfile(auth.idProfissional, auth.idSalao);
  if (!profile || !profile.active) {
    const error = new Error("Profissional inativo ou não encontrado.");
    (error as Error & { statusCode?: number }).statusCode = 403;
    throw error;
  }
  return profile;
}

async function loadAppointments(auth: ProfessionalAuthContext, date: string, limit = 50) {
  const result = await getAdminClient()
    .from("agendamentos")
    .select("id,data,hora_inicio,hora_fim,status,cliente_id,servico_id,id_comanda,clientes(nome),servicos(nome,preco,duracao_minutos),profissionais(nome,nome_exibicao)")
    .eq("id_salao", auth.idSalao)
    .eq("profissional_id", auth.idProfissional)
    .eq("data", date)
    .order("hora_inicio", { ascending: true })
    .limit(limit);
  throwIfSupabaseError(result.error, "Falha ao carregar agenda");
  return ((result.data || []) as AnyRecord[]).map((item) => appointmentPreview(item, auth.nome));
}

async function validateScheduleConflict(params: {
  idSalao: string;
  idProfissional: string;
  data: string;
  horaInicio: string;
  horaFim: string;
}) {
  const result = await getAdminClient()
    .from("agendamentos")
    .select("id,hora_inicio,hora_fim,status")
    .eq("id_salao", params.idSalao)
    .eq("profissional_id", params.idProfissional)
    .eq("data", params.data)
    .not("status", "in", "(cancelado,cancelada,expirado)")
    .limit(100);
  throwIfSupabaseError(result.error, "Falha ao validar conflito de agenda");

  const start = timeToMinutes(params.horaInicio);
  const end = timeToMinutes(params.horaFim);
  const conflict = ((result.data || []) as AnyRecord[]).some((item) => {
    const otherStart = timeToMinutes(item.hora_inicio);
    const otherEnd = timeToMinutes(item.hora_fim);
    return start < otherEnd && end > otherStart;
  });

  if (conflict) {
    const error = new Error("Este horário já está ocupado. Escolha outro horário.");
    (error as Error & { statusCode?: number }).statusCode = 409;
    throw error;
  }
}

function timeToMinutes(value: unknown) {
  const [hour, minute] = text(value).split(":").map(Number);
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
}

function addMinutes(time: string, minutes: number) {
  const total = timeToMinutes(time) + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export async function registerProfessionalMobileApiRoutes(app: FastifyInstance) {
  app.post("/api/profissional/auth/login", async (request, reply) => {
    const body = asRecord(request.body);
    const login = text(body.login || body.cpf || body.email || body.telefone, 180);
    const senha = text(body.senha || body.password, 300);
    const cpf = login.replace(/\D/g, "");
    if (!login || !senha) {
      return reply.code(400).send({ ok: false, error: "Informe CPF, telefone ou e-mail e senha." });
    }

    const supabase = getAdminClient();
    let acessoResult = await supabase
      .from("profissionais_acessos")
      .select("id,cpf,senha_hash,ativo,id_profissional")
      .eq("cpf", cpf || login)
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();

    if (!acessoResult.data && login.includes("@")) {
      acessoResult = await supabase
        .from("profissionais_acessos")
        .select("id,cpf,senha_hash,ativo,id_profissional")
        .eq("email", login.toLowerCase())
        .eq("ativo", true)
        .limit(1)
        .maybeSingle();
    }

    throwIfSupabaseError(acessoResult.error, "Falha ao validar acesso");
    const acesso = asRecord(acessoResult.data);
    const hash = text(acesso.senha_hash, 500);
    if (!acesso.id || !hash || !(await bcrypt.compare(senha, hash))) {
      return reply.code(401).send({ ok: false, error: "Login ou senha inválidos." });
    }

    const profile = await loadProfile(text(acesso.id_profissional));
    if (!profile || !profile.active) {
      return reply.code(403).send({ ok: false, error: "Profissional inativo ou sem permissão de acesso." });
    }

    await supabase
      .from("profissionais_acessos")
      .update({ ultimo_login_em: new Date().toISOString() })
      .eq("id", text(acesso.id));

    return buildTokens({ id: profile.id, idSalao: profile.salonId, nome: profile.name });
  });

  app.post("/api/profissional/auth/refresh", async (request, reply) => {
    const token = text(asRecord(request.body).refreshToken, 3000) || bearerTokenFromRequest(request);
    const payload = verifyProfessionalToken(token, "refresh");
    if (!payload) {
      return reply.code(401).send({ ok: false, error: "Sessão expirada. Entre novamente para continuar." });
    }

    const profile = await loadProfile(payload.idProfissional, payload.idSalao);
    if (!profile || !profile.active) {
      return reply.code(403).send({ ok: false, error: "Profissional inativo ou sem permissão de acesso." });
    }

    return buildTokens({ id: profile.id, idSalao: profile.salonId, nome: profile.name });
  });

  app.post("/api/profissional/auth/logout", async () => ({ ok: true }));

  app.get("/api/profissional/me", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    return requireCurrentProfile(auth);
  });

  app.get("/api/profissional/dashboard", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const profile = await requireCurrentProfile(auth);
    const date = todayDate();
    const appointments = await loadAppointments(auth, date, 20);
    const confirmedCount = appointments.filter((item) => item.status === "Confirmed").length;
    const pendingCount = appointments.filter((item) => item.status !== "Confirmed").length;

    const monthStart = currentMonthStart();
    const itemsResult = await getAdminClient()
      .from("comanda_itens")
      .select("id,valor_total,created_at")
      .eq("id_salao", auth.idSalao)
      .or(`id_profissional.eq.${auth.idProfissional},id_assistente.eq.${auth.idProfissional}`)
      .gte("created_at", `${monthStart}T00:00:00`)
      .limit(100);
    throwIfSupabaseError(itemsResult.error, "Falha ao carregar resumo do dia");
    const expectedRevenue = ((itemsResult.data || []) as AnyRecord[]).reduce(
      (acc, item) => acc + numberValue(item.valor_total),
      0,
    );

    return {
      professionalName: profile.name,
      salonName: profile.salonName,
      workday: {
        dateLabel: "Hoje",
        scheduleLabel: "Expediente configurado no salão.",
        appointmentCount: appointments.length,
        confirmedCount,
        pendingCount,
        expectedRevenue: cents(expectedRevenue),
      },
      appointments,
      quickActions: [
        {
          title: "Novo agendamento",
          description: "Reserve um horário com validação segura no servidor.",
        },
        {
          title: "Abrir comanda",
          description: "Registre serviços, produtos e comissão prevista.",
        },
        {
          title: "Buscar cliente",
          description: "Encontre cadastro, WhatsApp e histórico.",
        },
      ],
    };
  });

  app.get("/api/profissional/agenda", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const query = asRecord(request.query);
    return loadAppointments(auth, text(query.data, 20) || todayDate());
  });

  app.get("/api/profissional/agenda/mes", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const month = text(asRecord(request.query).mes, 7) || todayDate().slice(0, 7);
    const result = await getAdminClient()
      .from("agendamentos")
      .select("data")
      .eq("id_salao", auth.idSalao)
      .eq("profissional_id", auth.idProfissional)
      .gte("data", `${month}-01`)
      .lte("data", `${month}-31`)
      .limit(300);
    throwIfSupabaseError(result.error, "Falha ao carregar marcações do mês");
    return [...new Set(((result.data || []) as AnyRecord[]).map((item) => Number(text(item.data).slice(8, 10))).filter(Boolean))];
  });

  app.post("/api/profissional/agenda/reservas", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const body = asRecord(request.body);
    const data = text(body.data, 10);
    const horario = text(body.horario, 5);
    const servicoId = text(body.servicoId || body.servico_id);
    if (!data || !horario || !servicoId) {
      return reply.code(400).send({ ok: false, error: "Informe serviço, data e horário." });
    }

    const serviceResult = await getAdminClient()
      .from("servicos")
      .select("id,duracao_minutos")
      .eq("id_salao", auth.idSalao)
      .eq("id", servicoId)
      .limit(1)
      .maybeSingle();
    throwIfSupabaseError(serviceResult.error, "Falha ao validar serviço");
    const duration = Math.max(numberValue(asRecord(serviceResult.data).duracao_minutos), 30);
    await validateScheduleConflict({
      idSalao: auth.idSalao,
      idProfissional: auth.idProfissional,
      data,
      horaInicio: horario,
      horaFim: addMinutes(horario, duration),
    });

    return {
      id: `temp_${randomUUID()}`,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  });

  app.delete("/api/profissional/agenda/reservas/:id", async () => ({ ok: true }));

  app.get("/api/profissional/clientes", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const query = asRecord(request.query);
    const { page, limit, from, to } = pageFromQuery(query);
    const search = text(query.busca, 120);

    let dbQuery = getAdminClient()
      .from("clientes")
      .select("id,nome,telefone,whatsapp,celular,email,updated_at,created_at", { count: "exact" })
      .eq("id_salao", auth.idSalao)
      .order("updated_at", { ascending: false })
      .range(from, to);

    if (search) {
      dbQuery = dbQuery.or(`nome.ilike.%${search}%,telefone.ilike.%${search}%,whatsapp.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const result = await dbQuery;
    throwIfSupabaseError(result.error, "Falha ao carregar clientes");
    return {
      items: ((result.data || []) as AnyRecord[]).map(clientSummary),
      page,
      limit,
      hasNextPage: Number(result.count || 0) > page * limit,
    };
  });

  app.get("/api/profissional/comandas", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const query = asRecord(request.query);
    const { page, limit, from, to } = pageFromQuery(query);
    const status = text(query.status, 40);

    let dbQuery = getAdminClient()
      .from("comandas")
      .select("id,status,total,valor_total,created_at,clientes(nome),comanda_itens(id)", { count: "exact" })
      .eq("id_salao", auth.idSalao)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (status) dbQuery = dbQuery.eq("status", status);

    const result = await dbQuery;
    throwIfSupabaseError(result.error, "Falha ao carregar comandas");
    return {
      items: ((result.data || []) as AnyRecord[]).map((item) => ({
        id: text(item.id),
        clientName: text(nested(item.clientes).nome, 140) || "Cliente não informado",
        status: statusToCommandStatus(item.status),
        total: cents(item.total || item.valor_total),
        itemCount: Array.isArray(item.comanda_itens) ? item.comanda_itens.length : 0,
      })),
      page,
      limit,
      hasNextPage: Number(result.count || 0) > page * limit,
    };
  });

  app.get("/api/profissional/comissoes", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const query = asRecord(request.query);
    const start = text(query.inicio, 10) || currentMonthStart();
    const end = text(query.fim, 10) || todayDate();
    let dbQuery = getAdminClient()
      .from("comissoes_lancamentos")
      .select("id,descricao,valor_comissao,status,competencia_data")
      .eq("id_salao", auth.idSalao)
      .eq("id_profissional", auth.idProfissional)
      .gte("competencia_data", start)
      .lte("competencia_data", end)
      .order("competencia_data", { ascending: false })
      .limit(100);
    const status = text(query.status, 40);
    if (status) dbQuery = dbQuery.eq("status", status);
    const result = await dbQuery;
    throwIfSupabaseError(result.error, "Falha ao carregar comissões");
    return ((result.data || []) as AnyRecord[]).map((item) => ({
      id: text(item.id),
      description: text(item.descricao, 180) || "Comissão",
      date: text(item.competencia_data).slice(0, 10),
      value: cents(item.valor_comissao),
      status: statusToCommissionStatus(item.status),
    }));
  });

  app.get("/api/profissional/notificacoes", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const result = await getAdminClient()
      .from("notification_jobs")
      .select("id,type,status,payload,created_at")
      .eq("id_salao", auth.idSalao)
      .order("created_at", { ascending: false })
      .limit(30);
    if (result.error) return [];
    return ((result.data || []) as AnyRecord[]).map((item) => {
      const payload = asRecord(item.payload);
      return {
        id: text(item.id),
        title: text(payload.title || item.type, 120) || "Notificação",
        message: text(payload.body || payload.message || "Atualização do salão.", 220),
        date: text(item.created_at).slice(0, 10),
        read: false,
      };
    });
  });

  app.patch("/api/profissional/notificacoes/:id/lida", async () => ({ ok: true }));

  app.post("/api/profissional/device-token", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const body = asRecord(request.body);
    const token = text(body.token, 1000);
    if (!token) return reply.code(400).send({ ok: false, error: "Token do dispositivo obrigatório." });

    const result = await getAdminClient().from("profissionais_device_tokens").upsert(
      {
        id_salao: auth.idSalao,
        id_profissional: auth.idProfissional,
        token,
        plataforma: text(body.platform, 30) || "android",
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: "token" },
    );
    if (result.error) {
      request.log.warn({ err: result.error.message }, "Tabela de tokens FCM do profissional indisponível.");
    }
    return { ok: true };
  });
}
