import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
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
const RESERVATION_MINUTES = 10;

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
  if (["atendido", "finalizado", "completed"].includes(normalized)) return "Completed";
  if (["faltou", "no_show"].includes(normalized)) return "NoShow";
  if (["cancelado", "cancelada", "canceled"].includes(normalized)) return "Canceled";
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
    lastVisit: text(item.ultimo_atendimento || item.atualizado_em || item.created_at).slice(0, 10),
  };
}

function appointmentDetail(item: AnyRecord) {
  const cliente = nested(item.clientes);
  const servico = nested(item.servicos);
  return {
    id: text(item.id),
    date: text(item.data, 10),
    timeStart: text(item.hora_inicio, 5),
    timeEnd: text(item.hora_fim, 5),
    status: statusToAppointmentStatus(item.status),
    durationMinutes: numberValue(item.duracao_minutos),
    notes: text(item.observacoes, 1000),
    commandId: text(item.id_comanda),
    clientId: text(item.cliente_id || cliente.id),
    clientName: text(cliente.nome, 140) || "Cliente",
    clientPhone: text(cliente.whatsapp || cliente.telefone, 40),
    serviceId: text(item.servico_id || servico.id),
    serviceName: text(servico.nome, 140) || "ServiÃ§o",
    servicePrice: cents(servico.preco),
  };
}

async function loadProfile(idProfissional: string, idSalao?: string) {
  const supabase = getAdminClient();
  let query = supabase
    .from("profissionais")
    .select("id,nome,nome_exibicao,email,telefone,whatsapp,cpf,categoria,cargo,bio,foto_url,pix_tipo,pix_chave,notificacao_app_ativa,notificacao_email_ativa,ativo,status,id_salao,tipo_profissional,saloes(id,nome,status)")
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
    displayName: text(profissional.nome_exibicao, 140),
    category: text(profissional.categoria, 120),
    role: text(profissional.cargo || profissional.tipo_profissional, 120),
    cpf: text(profissional.cpf, 20),
    whatsapp: text(profissional.whatsapp || profissional.telefone, 40),
    photoUrl: text(profissional.foto_url, 500),
    bio: text(profissional.bio, 1000),
    pixType: text(profissional.pix_tipo, 40),
    pixKey: text(profissional.pix_chave, 200),
    appNotificationsEnabled: profissional.notificacao_app_ativa !== false,
    emailNotificationsEnabled: profissional.notificacao_email_ativa !== false,
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
  ignoreAppointmentId?: string;
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
    if (params.ignoreAppointmentId && text(item.id) === params.ignoreAppointmentId) return false;
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

function dateOnly(value: unknown) {
  return text(value, 10);
}

function nullableText(value: unknown, maxLength = 300) {
  const valueText = text(value, maxLength);
  return valueText || null;
}

function requestedMoney(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.round(parsed * 100) / 100;
}

function sanitizePhone(value: unknown) {
  return text(value, 40).replace(/[^\d+]/g, "");
}

async function loadService(idSalao: string, idServico: string) {
  const result = await getAdminClient()
    .from("servicos")
    .select("id,nome,preco,duracao,duracao_minutos,comissao_percentual,comissao_percentual_padrao,ativo,status")
    .eq("id_salao", idSalao)
    .eq("id", idServico)
    .limit(1)
    .maybeSingle();
  throwIfSupabaseError(result.error, "Falha ao carregar serviço");
  const service = asRecord(result.data);
  if (!service.id) {
    const error = new Error("Serviço não encontrado.");
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }
  return service;
}

async function loadProduct(idSalao: string, idProduto: string) {
  const result = await getAdminClient()
    .from("produtos")
    .select("id,nome,preco_venda,preco_custo,ativo,status")
    .eq("id_salao", idSalao)
    .eq("id", idProduto)
    .limit(1)
    .maybeSingle();
  throwIfSupabaseError(result.error, "Falha ao carregar produto");
  const product = asRecord(result.data);
  if (!product.id) {
    const error = new Error("Produto não encontrado.");
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }
  return product;
}

async function ensureClientBelongsToSalon(idSalao: string, idCliente: string) {
  const result = await getAdminClient()
    .from("clientes")
    .select("id,nome")
    .eq("id_salao", idSalao)
    .eq("id", idCliente)
    .limit(1)
    .maybeSingle();
  throwIfSupabaseError(result.error, "Falha ao validar cliente");
  if (!result.data?.id) {
    const error = new Error("Cliente não encontrado.");
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }
}

async function validateReservationConflict(params: {
  idSalao: string;
  idProfissional: string;
  data: string;
  horaInicio: string;
  horaFim: string;
  ignoreReservationId?: string;
}) {
  const result = await getAdminClient()
    .from("profissional_reservas_horario")
    .select("id,hora_inicio,hora_fim,status,expira_em")
    .eq("id_salao", params.idSalao)
    .eq("id_profissional", params.idProfissional)
    .eq("data", params.data)
    .eq("status", "ativa")
    .gt("expira_em", new Date().toISOString())
    .limit(100);
  throwIfSupabaseError(result.error, "Falha ao validar reserva do horário");

  const start = timeToMinutes(params.horaInicio);
  const end = timeToMinutes(params.horaFim);
  const conflict = ((result.data || []) as AnyRecord[]).some((item) => {
    if (params.ignoreReservationId && text(item.id) === params.ignoreReservationId) return false;
    const otherStart = timeToMinutes(item.hora_inicio);
    const otherEnd = timeToMinutes(item.hora_fim);
    return start < otherEnd && end > otherStart;
  });

  if (conflict) {
    const error = new Error("Este horário está reservado por alguns minutos. Escolha outro horário.");
    (error as Error & { statusCode?: number }).statusCode = 409;
    throw error;
  }
}

async function nextCommandNumber(idSalao: string) {
  const result = await getAdminClient()
    .from("comandas")
    .select("numero")
    .eq("id_salao", idSalao)
    .order("numero", { ascending: false })
    .limit(1);
  throwIfSupabaseError(result.error, "Falha ao gerar número da comanda");
  return Number(((result.data || []) as AnyRecord[])[0]?.numero || 0) + 1;
}

async function recalculateCommandTotals(idSalao: string, idComanda: string) {
  const itemsResult = await getAdminClient()
    .from("comanda_itens")
    .select("valor_total,ativo")
    .eq("id_salao", idSalao)
    .eq("id_comanda", idComanda);
  throwIfSupabaseError(itemsResult.error, "Falha ao recalcular comanda");
  const subtotal = ((itemsResult.data || []) as AnyRecord[])
    .filter((item) => item.ativo !== false)
    .reduce((acc, item) => acc + numberValue(item.valor_total), 0);
  const update = await getAdminClient()
    .from("comandas")
    .update({ subtotal, total: subtotal, updated_at: new Date().toISOString() })
    .eq("id_salao", idSalao)
    .eq("id", idComanda);
  throwIfSupabaseError(update.error, "Falha ao atualizar total da comanda");
  return subtotal;
}

async function commandBelongsToSalon(idSalao: string, idComanda: string) {
  const result = await getAdminClient()
    .from("comandas")
    .select("id,status")
    .eq("id_salao", idSalao)
    .eq("id", idComanda)
    .limit(1)
    .maybeSingle();
  throwIfSupabaseError(result.error, "Falha ao validar comanda");
  const command = asRecord(result.data);
  if (!command.id) {
    const error = new Error("Comanda não encontrada.");
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }
  return command;
}

export async function registerProfessionalMobileApiRoutes(app: FastifyInstance) {
  app.post("/api/profissional/auth/login", async (request, reply) => {
    const body = asRecord(request.body);
    const cpf = text(body.cpf || body.login, 30).replace(/\D/g, "");
    const senha = text(body.senha || body.password, 300);
    if (cpf.length !== 11 || !senha) {
      return reply.code(400).send({ ok: false, error: "Informe CPF e senha." });
    }

    const supabase = getAdminClient();
    const acessoResult = await supabase
      .from("profissionais_acessos")
      .select("id,cpf,senha_hash,ativo,id_profissional")
      .eq("cpf", cpf)
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();

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
    const clienteId = text(body.clienteId || body.cliente_id);
    const servicoId = text(body.servicoId || body.servico_id);
    if (!data || !horario || !servicoId) {
      return reply.code(400).send({ ok: false, error: "Informe serviço, data e horário." });
    }

    const service = await loadService(auth.idSalao, servicoId);
    const duration = Math.max(numberValue(service.duracao_minutos || service.duracao), 30);
    const horaFim = addMinutes(horario, duration);
    await validateScheduleConflict({
      idSalao: auth.idSalao,
      idProfissional: auth.idProfissional,
      data,
      horaInicio: horario,
      horaFim,
    });
    await validateReservationConflict({
      idSalao: auth.idSalao,
      idProfissional: auth.idProfissional,
      data,
      horaInicio: horario,
      horaFim,
    });

    if (clienteId) await ensureClientBelongsToSalon(auth.idSalao, clienteId);

    const expiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000).toISOString();
    const reservation = await getAdminClient()
      .from("profissional_reservas_horario")
      .insert({
        id_salao: auth.idSalao,
        id_profissional: auth.idProfissional,
        id_cliente: clienteId || null,
        id_servico: servicoId,
        data,
        hora_inicio: horario,
        hora_fim: horaFim,
        expira_em: expiresAt,
      })
      .select("id,expira_em")
      .single();
    throwIfSupabaseError(reservation.error, "Falha ao reservar horário");

    return {
      id: text(reservation.data?.id),
      expiresAt: text(reservation.data?.expira_em),
    };
  });

  app.delete("/api/profissional/agenda/reservas/:id", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    if (!id) return reply.code(400).send({ ok: false, error: "Reserva obrigatória." });
    const result = await getAdminClient()
      .from("profissional_reservas_horario")
      .update({ status: "cancelada", atualizado_em: new Date().toISOString() })
      .eq("id_salao", auth.idSalao)
      .eq("id_profissional", auth.idProfissional)
      .eq("id", id);
    throwIfSupabaseError(result.error, "Falha ao cancelar reserva");
    return { ok: true };
  });

  app.post("/api/profissional/agendamentos", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const body = asRecord(request.body);
    const clienteId = text(body.clienteId || body.cliente_id);
    const servicoId = text(body.servicoId || body.servico_id);
    const reservaId = text(body.reservaId || body.id_reserva);
    const data = dateOnly(body.data);
    const horario = text(body.horario || body.hora_inicio, 5);
    if (!clienteId || !servicoId || !data || !horario) {
      return reply.code(400).send({ ok: false, error: "Informe cliente, serviço, data e horário." });
    }
    await ensureClientBelongsToSalon(auth.idSalao, clienteId);
    const service = await loadService(auth.idSalao, servicoId);
    const duration = Math.max(numberValue(service.duracao_minutos || service.duracao), 30);
    const horaFim = addMinutes(horario, duration);
    await validateScheduleConflict({
      idSalao: auth.idSalao,
      idProfissional: auth.idProfissional,
      data,
      horaInicio: horario,
      horaFim,
    });
    await validateReservationConflict({
      idSalao: auth.idSalao,
      idProfissional: auth.idProfissional,
      data,
      horaInicio: horario,
      horaFim,
      ignoreReservationId: reservaId,
    });
    if (reservaId) {
      const reserveResult = await getAdminClient()
        .from("profissional_reservas_horario")
        .update({ status: "confirmada", atualizado_em: new Date().toISOString() })
        .eq("id_salao", auth.idSalao)
        .eq("id_profissional", auth.idProfissional)
        .eq("id", reservaId)
        .eq("status", "ativa")
        .gt("expira_em", new Date().toISOString());
      throwIfSupabaseError(reserveResult.error, "Falha ao confirmar reserva");
    }
    const created = await getAdminClient()
      .from("agendamentos")
      .insert({
        id_salao: auth.idSalao,
        cliente_id: clienteId,
        profissional_id: auth.idProfissional,
        servico_id: servicoId,
        data,
        hora_inicio: horario,
        hora_fim: horaFim,
        status: text(body.status, 40) || "confirmado",
        duracao_minutos: duration,
        observacoes: nullableText(body.observacoes, 1000),
        origem: "app_profissional",
      })
      .select("id,data,hora_inicio,hora_fim,status,cliente_id,servico_id,id_comanda,clientes(nome),servicos(nome,preco,duracao_minutos),profissionais(nome,nome_exibicao)")
      .single();
    throwIfSupabaseError(created.error, "Falha ao criar agendamento");
    return appointmentPreview(asRecord(created.data), auth.nome);
  });

  app.get("/api/profissional/agendamentos/:id", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    const result = await getAdminClient()
      .from("agendamentos")
      .select("id,data,hora_inicio,hora_fim,status,duracao_minutos,observacoes,id_comanda,cliente_id,profissional_id,servico_id,clientes(id,nome,telefone,whatsapp,email),servicos(id,nome,preco,duracao_minutos)")
      .eq("id_salao", auth.idSalao)
      .eq("profissional_id", auth.idProfissional)
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    throwIfSupabaseError(result.error, "Falha ao carregar agendamento");
    if (!result.data?.id) return reply.code(404).send({ ok: false, error: "Agendamento não encontrado." });
    return appointmentDetail(asRecord(result.data));
  });

  app.patch("/api/profissional/agendamentos/:id", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    const body = asRecord(request.body);
    const update: AnyRecord = { updated_at: new Date().toISOString() };
    if ("observacoes" in body) update.observacoes = nullableText(body.observacoes, 1000);
    if ("status" in body) update.status = text(body.status, 40);
    const data = dateOnly(body.data);
    const horario = text(body.horario || body.hora_inicio, 5);
    const servicoId = text(body.servicoId || body.servico_id);
    if (data || horario || servicoId) {
      const current = await getAdminClient()
        .from("agendamentos")
        .select("id,data,hora_inicio,servico_id")
        .eq("id_salao", auth.idSalao)
        .eq("profissional_id", auth.idProfissional)
        .eq("id", id)
        .limit(1)
        .maybeSingle();
      throwIfSupabaseError(current.error, "Falha ao validar agendamento");
      if (!current.data?.id) return reply.code(404).send({ ok: false, error: "Agendamento não encontrado." });
      const finalData = data || text(current.data.data, 10);
      const finalHorario = horario || text(current.data.hora_inicio, 5);
      const finalServico = servicoId || text(current.data.servico_id);
      const service = await loadService(auth.idSalao, finalServico);
      const duration = Math.max(numberValue(service.duracao_minutos || service.duracao), 30);
      const horaFim = addMinutes(finalHorario, duration);
      await validateScheduleConflict({
        idSalao: auth.idSalao,
        idProfissional: auth.idProfissional,
        data: finalData,
        horaInicio: finalHorario,
        horaFim,
        ignoreAppointmentId: id,
      });
      update.data = finalData;
      update.hora_inicio = finalHorario;
      update.hora_fim = horaFim;
      update.servico_id = finalServico;
      update.duracao_minutos = duration;
    }
    const result = await getAdminClient()
      .from("agendamentos")
      .update(update)
      .eq("id_salao", auth.idSalao)
      .eq("profissional_id", auth.idProfissional)
      .eq("id", id)
      .select("id,data,hora_inicio,hora_fim,status,cliente_id,servico_id,id_comanda,clientes(nome),servicos(nome,preco,duracao_minutos),profissionais(nome,nome_exibicao)")
      .single();
    throwIfSupabaseError(result.error, "Falha ao atualizar agendamento");
    return appointmentPreview(asRecord(result.data), auth.nome);
  });

  app.post("/api/profissional/agendamentos/:id/cancelar", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    const result = await getAdminClient()
      .from("agendamentos")
      .update({ status: "cancelado", updated_at: new Date().toISOString() })
      .eq("id_salao", auth.idSalao)
      .eq("profissional_id", auth.idProfissional)
      .eq("id", id);
    throwIfSupabaseError(result.error, "Falha ao cancelar agendamento");
    return { ok: true };
  });

  app.post("/api/profissional/agendamentos/:id/status", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    const status = text(asRecord(request.body).status, 40);
    if (!status) return reply.code(400).send({ ok: false, error: "Informe o status." });
    const result = await getAdminClient()
      .from("agendamentos")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id_salao", auth.idSalao)
      .eq("profissional_id", auth.idProfissional)
      .eq("id", id);
    throwIfSupabaseError(result.error, "Falha ao atualizar status");
    return { ok: true };
  });

  app.get("/api/profissional/clientes", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const query = asRecord(request.query);
    const { page, limit, from, to } = pageFromQuery(query);
    const search = text(query.busca, 120);

    let dbQuery = getAdminClient()
      .from("clientes")
      .select("id,nome,telefone,whatsapp,email,atualizado_em,created_at", { count: "exact" })
      .eq("id_salao", auth.idSalao)
      .is("deleted_at", null)
      .order("atualizado_em", { ascending: false, nullsFirst: false })
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

  app.post("/api/profissional/clientes", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const body = asRecord(request.body);
    const nome = text(body.nome || body.name, 140);
    if (!nome) return reply.code(400).send({ ok: false, error: "Informe o nome do cliente." });
    const payload = {
      id_salao: auth.idSalao,
      nome,
      telefone: sanitizePhone(body.telefone || body.phone),
      whatsapp: sanitizePhone(body.whatsapp || body.telefone || body.phone),
      email: nullableText(body.email, 180),
      cpf: nullableText(body.cpf, 20),
      data_nascimento: nullableText(body.dataNascimento || body.data_nascimento, 20),
      observacoes: nullableText(body.observacoes || body.notes, 1000),
      status: text(body.status, 40) || "ativo",
      ativo: "true",
      created_at: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
    };
    const result = await getAdminClient().from("clientes").insert(payload).select("id,nome,telefone,whatsapp,email,atualizado_em,created_at").single();
    throwIfSupabaseError(result.error, "Falha ao cadastrar cliente");
    return clientSummary(asRecord(result.data));
  });

  app.get("/api/profissional/clientes/:id", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    const result = await getAdminClient()
      .from("clientes")
      .select("id,nome,nome_social,telefone,whatsapp,email,cpf,data_nascimento,cep,rua,numero,bairro,cidade,estado,observacoes,status,atualizado_em,created_at")
      .eq("id_salao", auth.idSalao)
      .eq("id", id)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    throwIfSupabaseError(result.error, "Falha ao carregar cliente");
    if (!result.data?.id) return reply.code(404).send({ ok: false, error: "Cliente não encontrado." });
    const item = asRecord(result.data);
    return {
      id: text(item.id),
      name: text(item.nome, 140) || "Cliente",
      socialName: text(item.nome_social, 140),
      phone: text(item.telefone, 40),
      whatsapp: text(item.whatsapp || item.telefone, 40),
      email: text(item.email, 180),
      cpf: text(item.cpf, 20),
      birthDate: text(item.data_nascimento, 20),
      address: [item.rua, item.numero, item.bairro, item.cidade, item.estado].map((value) => text(value, 120)).filter(Boolean).join(", "),
      notes: text(item.observacoes, 1000),
      status: text(item.status, 40) || "ativo",
    };
  });

  app.patch("/api/profissional/clientes/:id", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    const body = asRecord(request.body);
    const update: AnyRecord = {
      atualizado_em: new Date().toISOString(),
    };
    for (const [field, max] of Object.entries({
      nome: 140,
      nome_social: 140,
      email: 180,
      cpf: 20,
      data_nascimento: 20,
      cep: 20,
      rua: 180,
      numero: 30,
      bairro: 120,
      cidade: 120,
      estado: 2,
      observacoes: 1000,
      status: 40,
    })) {
      if (field in body) update[field] = nullableText(body[field], max);
    }
    if ("telefone" in body || "phone" in body) update.telefone = sanitizePhone(body.telefone || body.phone);
    if ("whatsapp" in body) update.whatsapp = sanitizePhone(body.whatsapp);
    const result = await getAdminClient()
      .from("clientes")
      .update(update)
      .eq("id_salao", auth.idSalao)
      .eq("id", id)
      .select("id,nome,telefone,whatsapp,email,atualizado_em,created_at")
      .single();
    throwIfSupabaseError(result.error, "Falha ao atualizar cliente");
    return clientSummary(asRecord(result.data));
  });

  app.get("/api/profissional/clientes/:id/historico", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    await ensureClientBelongsToSalon(auth.idSalao, id);
    const result = await getAdminClient()
      .from("agendamentos")
      .select("id,data,hora_inicio,hora_fim,status,servicos(nome,preco,duracao_minutos)")
      .eq("id_salao", auth.idSalao)
      .eq("cliente_id", id)
      .order("data", { ascending: false })
      .limit(30);
    throwIfSupabaseError(result.error, "Falha ao carregar histórico do cliente");
    return ((result.data || []) as AnyRecord[]).map((item) => appointmentPreview(item, auth.nome));
  });

  app.get("/api/profissional/servicos", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const query = asRecord(request.query);
    const search = text(query.busca, 120);
    let dbQuery = getAdminClient()
      .from("servicos")
      .select("id,nome,descricao,categoria,preco,duracao,duracao_minutos,ativo,status")
      .eq("id_salao", auth.idSalao)
      .eq("ativo", true)
      .order("nome", { ascending: true })
      .limit(50);
    if (search) dbQuery = dbQuery.ilike("nome", `%${search}%`);
    const result = await dbQuery;
    throwIfSupabaseError(result.error, "Falha ao carregar serviços");
    return ((result.data || []) as AnyRecord[]).map((item) => ({
      id: text(item.id),
      name: text(item.nome, 160),
      description: text(item.descricao, 240),
      price: cents(item.preco),
      durationMinutes: numberValue(item.duracao_minutos || item.duracao),
      type: "servico",
    }));
  });

  app.get("/api/profissional/produtos", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const query = asRecord(request.query);
    const search = text(query.busca, 120);
    let dbQuery = getAdminClient()
      .from("produtos")
      .select("id,nome,marca,preco_venda,estoque_atual,ativo,status")
      .eq("id_salao", auth.idSalao)
      .eq("ativo", true)
      .order("nome", { ascending: true })
      .limit(50);
    if (search) dbQuery = dbQuery.ilike("nome", `%${search}%`);
    const result = await dbQuery;
    throwIfSupabaseError(result.error, "Falha ao carregar produtos");
    return ((result.data || []) as AnyRecord[]).map((item) => ({
      id: text(item.id),
      name: text(item.nome, 160),
      description: text(item.marca, 160),
      price: cents(item.preco_venda),
      stock: numberValue(item.estoque_atual),
      type: "produto",
    }));
  });

  app.get("/api/profissional/comandas", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const query = asRecord(request.query);
    const { page, limit, from, to } = pageFromQuery(query);
    const status = text(query.status, 40);

    let dbQuery = getAdminClient()
      .from("comandas")
      .select("id,status,total,created_at,clientes(nome),comanda_itens(id)", { count: "exact" })
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
        total: cents(item.total),
        itemCount: Array.isArray(item.comanda_itens) ? item.comanda_itens.length : 0,
      })),
      page,
      limit,
      hasNextPage: Number(result.count || 0) > page * limit,
    };
  });

  app.post("/api/profissional/comandas", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const body = asRecord(request.body);
    const clienteId = text(body.clienteId || body.id_cliente);
    if (clienteId) await ensureClientBelongsToSalon(auth.idSalao, clienteId);
    const numero = await nextCommandNumber(auth.idSalao);
    const result = await getAdminClient()
      .from("comandas")
      .insert({
        id_salao: auth.idSalao,
        numero,
        id_cliente: clienteId || null,
        status: "aberta",
        origem: "app_profissional",
        observacoes: nullableText(body.observacoes, 1000),
        subtotal: 0,
        desconto: 0,
        acrescimo: 0,
        total: 0,
      })
      .select("id,status,total,created_at,clientes(nome),comanda_itens(id)")
      .single();
    throwIfSupabaseError(result.error, "Falha ao criar comanda");
    const item = asRecord(result.data);
    return {
      id: text(item.id),
      clientName: text(nested(item.clientes).nome, 140) || "Cliente não informado",
      status: statusToCommandStatus(item.status),
      total: cents(item.total),
      itemCount: 0,
    };
  });

  app.get("/api/profissional/comandas/:id", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    const result = await getAdminClient()
      .from("comandas")
      .select("id,numero,status,origem,observacoes,subtotal,desconto,acrescimo,total,created_at,updated_at,clientes(id,nome,telefone,whatsapp),comanda_itens(id,tipo_item,descricao,quantidade,valor_unitario,valor_total,id_servico,id_produto,id_profissional,created_at)")
      .eq("id_salao", auth.idSalao)
      .eq("id", id)
      .limit(1)
      .maybeSingle();
    throwIfSupabaseError(result.error, "Falha ao carregar comanda");
    if (!result.data?.id) return reply.code(404).send({ ok: false, error: "Comanda não encontrada." });
    const item = asRecord(result.data);
    const cliente = nested(item.clientes);
    return {
      id: text(item.id),
      number: text(item.numero, 30),
      clientName: text(cliente.nome, 140) || "Cliente não informado",
      clientPhone: text(cliente.whatsapp || cliente.telefone, 40),
      status: statusToCommandStatus(item.status),
      subtotal: cents(item.subtotal),
      discount: cents(item.desconto),
      addition: cents(item.acrescimo),
      total: cents(item.total),
      notes: text(item.observacoes, 1000),
      items: ((item.comanda_itens || []) as AnyRecord[]).map((row) => ({
        id: text(row.id),
        type: text(row.tipo_item || "item", 40),
        description: text(row.descricao, 180),
        quantity: numberValue(row.quantidade),
        unitValue: cents(row.valor_unitario),
        totalValue: cents(row.valor_total),
      })),
    };
  });

  app.post("/api/profissional/comandas/:id/itens", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const idComanda = text(asRecord(request.params).id);
    await commandBelongsToSalon(auth.idSalao, idComanda);
    const body = asRecord(request.body);
    const tipo = text(body.tipo || body.tipo_item, 30) || "servico";
    const quantidade = Math.max(numberValue(body.quantidade || 1), 1);
    let descricao = text(body.descricao, 180);
    let valorUnitario = requestedMoney(body.valorUnitario || body.valor_unitario);
    let custoTotal = 0;
    let idServico: string | null = null;
    let idProduto: string | null = null;

    if (tipo === "produto") {
      idProduto = text(body.produtoId || body.id_produto);
      if (!idProduto) return reply.code(400).send({ ok: false, error: "Informe o produto." });
      const product = await loadProduct(auth.idSalao, idProduto);
      descricao = descricao || text(product.nome, 180);
      valorUnitario = valorUnitario || requestedMoney(product.preco_venda);
      custoTotal = requestedMoney(product.preco_custo) * quantidade;
    } else {
      idServico = text(body.servicoId || body.id_servico);
      if (!idServico) return reply.code(400).send({ ok: false, error: "Informe o serviço." });
      const service = await loadService(auth.idSalao, idServico);
      descricao = descricao || text(service.nome, 180);
      valorUnitario = valorUnitario || requestedMoney(service.preco);
    }

    if (!descricao || valorUnitario <= 0) {
      return reply.code(400).send({ ok: false, error: "Informe um item com valor válido." });
    }

    const valorTotal = Math.round(valorUnitario * quantidade * 100) / 100;
    const itemResult = await getAdminClient()
      .from("comanda_itens")
      .insert({
        id_salao: auth.idSalao,
        id_comanda: idComanda,
        tipo_item: tipo === "produto" ? "produto" : "servico",
        tipo,
        id_servico: idServico,
        id_produto: idProduto,
        descricao,
        quantidade,
        valor_unitario: valorUnitario,
        valor_total: valorTotal,
        custo_total: custoTotal,
        id_profissional: auth.idProfissional,
        origem: "app_profissional",
        ativo: true,
      })
      .select("id,tipo_item,descricao,quantidade,valor_unitario,valor_total")
      .single();
    throwIfSupabaseError(itemResult.error, "Falha ao adicionar item");
    await recalculateCommandTotals(auth.idSalao, idComanda);
    return itemResult.data;
  });

  app.delete("/api/profissional/comandas/:id/itens/:itemId", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const params = asRecord(request.params);
    const idComanda = text(params.id);
    const itemId = text(params.itemId);
    await commandBelongsToSalon(auth.idSalao, idComanda);
    const result = await getAdminClient()
      .from("comanda_itens")
      .update({ ativo: false, updated_at: new Date().toISOString() })
      .eq("id_salao", auth.idSalao)
      .eq("id_comanda", idComanda)
      .eq("id", itemId);
    throwIfSupabaseError(result.error, "Falha ao remover item");
    await recalculateCommandTotals(auth.idSalao, idComanda);
    return { ok: true };
  });

  app.post("/api/profissional/comandas/:id/enviar-caixa", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    await commandBelongsToSalon(auth.idSalao, id);
    await recalculateCommandTotals(auth.idSalao, id);
    const result = await getAdminClient()
      .from("comandas")
      .update({ status: "enviada_caixa", updated_at: new Date().toISOString() })
      .eq("id_salao", auth.idSalao)
      .eq("id", id)
      .select("id,status,total,created_at,clientes(nome),comanda_itens(id)")
      .single();
    throwIfSupabaseError(result.error, "Falha ao enviar comanda para o caixa");
    const item = asRecord(result.data);
    return {
      id: text(item.id),
      clientName: text(nested(item.clientes).nome, 140) || "Cliente não informado",
      status: statusToCommandStatus(item.status),
      total: cents(item.total),
      itemCount: Array.isArray(item.comanda_itens) ? item.comanda_itens.length : 0,
    };
  });

  app.post("/api/profissional/comandas/:id/cancelar", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id);
    await commandBelongsToSalon(auth.idSalao, id);
    const body = asRecord(request.body);
    const result = await getAdminClient()
      .from("comandas")
      .update({
        status: "cancelada",
        motivo_cancelamento: nullableText(body.motivo || body.motivo_cancelamento, 500),
        cancelada_em: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id_salao", auth.idSalao)
      .eq("id", id);
    throwIfSupabaseError(result.error, "Falha ao cancelar comanda");
    return { ok: true };
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
    const supabase = getAdminClient();
    const [result, readResult] = await Promise.all([
      supabase
      .from("notification_jobs")
      .select("id,type,status,payload,created_at")
      .eq("id_salao", auth.idSalao)
      .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("profissionais_notificacoes_lidas")
        .select("id_notificacao")
        .eq("id_salao", auth.idSalao)
        .eq("id_profissional", auth.idProfissional)
        .limit(200),
    ]);
    if (result.error) return [];
    const readIds = new Set(((readResult.data || []) as AnyRecord[]).map((item) => text(item.id_notificacao)));
    return ((result.data || []) as AnyRecord[]).map((item) => {
      const payload = asRecord(item.payload);
      const id = text(item.id);
      return {
        id,
        title: text(payload.title || item.type, 120) || "Notificação",
        message: text(payload.body || payload.message || "Atualização do salão.", 220),
        date: text(item.created_at).slice(0, 10),
        read: readIds.has(id),
      };
    });
  });

  app.patch("/api/profissional/notificacoes/:id/lida", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const id = text(asRecord(request.params).id, 200);
    if (!id) return reply.code(400).send({ ok: false, error: "Notificação obrigatória." });
    const result = await getAdminClient()
      .from("profissionais_notificacoes_lidas")
      .upsert(
        {
          id_salao: auth.idSalao,
          id_profissional: auth.idProfissional,
          id_notificacao: id,
          lida_em: new Date().toISOString(),
        },
        { onConflict: "id_profissional,id_notificacao" },
      );
    throwIfSupabaseError(result.error, "Falha ao marcar notificação como lida");
    return { ok: true };
  });

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

  app.patch("/api/profissional/perfil", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const body = asRecord(request.body);
    const update: AnyRecord = {};
    if ("nome" in body || "name" in body) update.nome = text(body.nome || body.name, 140);
    if ("nome_exibicao" in body || "displayName" in body) {
      update.nome_exibicao = text(body.nome_exibicao || body.displayName, 140);
    }
    if ("telefone" in body || "phone" in body) update.telefone = sanitizePhone(body.telefone || body.phone);
    if ("whatsapp" in body) update.whatsapp = sanitizePhone(body.whatsapp);
    if ("email" in body) update.email = nullableText(body.email, 180);
    if ("bio" in body) update.bio = nullableText(body.bio, 1000);
    if ("notificacoes_ativas" in body) update.notificacoes_ativas = Boolean(body.notificacoes_ativas);
    if (!Object.keys(update).length) return requireCurrentProfile(auth);
    const result = await getAdminClient()
      .from("profissionais")
      .update(update)
      .eq("id_salao", auth.idSalao)
      .eq("id", auth.idProfissional);
    throwIfSupabaseError(result.error, "Falha ao atualizar perfil");
    return requireCurrentProfile(auth);
  });

  app.post("/api/profissional/alterar-senha", async (request, reply) => {
    const auth = requireProfessionalAuth(request, reply);
    if (!auth) return;
    const body = asRecord(request.body);
    const senhaAtual = text(body.senhaAtual || body.senha_atual || body.currentPassword, 300);
    const novaSenha = text(body.novaSenha || body.nova_senha || body.newPassword, 300);
    if (!senhaAtual || novaSenha.length < 6) {
      return reply.code(400).send({ ok: false, error: "Informe a senha atual e uma nova senha com pelo menos 6 caracteres." });
    }
    const acessoResult = await getAdminClient()
      .from("profissionais_acessos")
      .select("id,senha_hash")
      .eq("id_profissional", auth.idProfissional)
      .eq("ativo", true)
      .limit(1)
      .maybeSingle();
    throwIfSupabaseError(acessoResult.error, "Falha ao validar senha");
    const acesso = asRecord(acessoResult.data);
    const hash = text(acesso.senha_hash, 500);
    if (!acesso.id || !hash || !(await bcrypt.compare(senhaAtual, hash))) {
      return reply.code(401).send({ ok: false, error: "Senha atual inválida." });
    }
    const newHash = await bcrypt.hash(novaSenha, 10);
    const result = await getAdminClient()
      .from("profissionais_acessos")
      .update({ senha_hash: newHash, atualizado_em: new Date().toISOString() })
      .eq("id", text(acesso.id));
    throwIfSupabaseError(result.error, "Falha ao alterar senha");
    return { ok: true };
  });
}
