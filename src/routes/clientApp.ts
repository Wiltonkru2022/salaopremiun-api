import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { requireAdminToken } from "../lib/auth.js";
import { getSupabaseAdmin } from "../lib/supabase.js";

type AnyRecord = Record<string, unknown>;

const LOOKAHEAD_DAYS = 45;
const BUFFER_MINUTES = 5;
const SLOT_STEP_MINUTES = 5;

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

function text(value: unknown) {
  return String(value || "").trim();
}

function limitFromQuery(query: AnyRecord, fallback = 20, max = 100) {
  const parsed = Number(query.limit || fallback);
  return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : fallback, max);
}

function normalizeTimeString(time: unknown) {
  const raw = text(time);
  if (!raw) return "00:00";
  const parts = raw.split(":");
  return `${String(parts[0] || "0").padStart(2, "0")}:${String(parts[1] || "0").padStart(2, "0")}`;
}

function timeToMinutes(time: unknown) {
  const [hour, minute] = normalizeTimeString(time).split(":").map(Number);
  return hour * 60 + minute;
}

function minutesToTime(total: number) {
  const safe = Math.max(0, total);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function addDurationToTime(time: unknown, durationMinutes: number) {
  return minutesToTime(timeToMinutes(time) + Number(durationMinutes || 0));
}

function overlaps(startA: string, endA: string, startB: string, endB: string) {
  return timeToMinutes(startA) < timeToMinutes(endB) && timeToMinutes(endA) > timeToMinutes(startB);
}

function formatDateString(date: Date) {
  return date.toISOString().slice(0, 10);
}

function normalizeDia(value: unknown) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function weekDayName(date: Date) {
  return ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"][date.getDay()];
}

function parseJsonArray(value: unknown): AnyRecord[] {
  if (Array.isArray(value)) return value as AnyRecord[];
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isBusinessDay(dateString: string, diasFuncionamento: unknown) {
  const dias = Array.isArray(diasFuncionamento)
    ? diasFuncionamento.map(normalizeDia)
    : ["segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
  return dias.includes(weekDayName(new Date(`${dateString}T12:00:00`)));
}

function professionalWorkWindow(dateString: string, profissional: AnyRecord, config: AnyRecord) {
  const dias = parseJsonArray(profissional.dias_trabalho);
  const day = weekDayName(new Date(`${dateString}T12:00:00`));
  const found = dias.find((item) => normalizeDia(item.dia) === day);

  if (!found) {
    return {
      active: true,
      inicio: normalizeTimeString(config.hora_abertura || "08:00"),
      fim: normalizeTimeString(config.hora_fechamento || "19:00"),
    };
  }

  return {
    active: found.ativo !== false,
    inicio: normalizeTimeString(found.inicio || config.hora_abertura || "08:00"),
    fim: normalizeTimeString(found.fim || config.hora_fechamento || "19:00"),
  };
}

function buildSlots(params: {
  data: string;
  config: AnyRecord;
  profissional: AnyRecord;
  duracao: number;
  bloqueios: AnyRecord[];
  agendamentos: AnyRecord[];
  ignoreAgendamentoId?: string | null;
}) {
  if (!isBusinessDay(params.data, params.config.dias_funcionamento)) return [];

  const salonStart = normalizeTimeString(params.config.hora_abertura || "08:00");
  const salonEnd = normalizeTimeString(params.config.hora_fechamento || "19:00");
  const work = professionalWorkWindow(params.data, params.profissional, params.config);
  if (!work.active) return [];

  const pausas = parseJsonArray(params.profissional.pausas)
    .filter((item) => item.inicio && item.fim)
    .map((item) => ({
      hora_inicio: normalizeTimeString(item.inicio),
      hora_fim: normalizeTimeString(item.fim),
    }));

  const bloqueios = [
    ...params.bloqueios.map((item) => ({
      hora_inicio: normalizeTimeString(item.hora_inicio),
      hora_fim: normalizeTimeString(item.hora_fim),
    })),
    ...pausas,
  ];

  if (timeToMinutes(work.inicio) > timeToMinutes(salonStart)) {
    bloqueios.push({ hora_inicio: salonStart, hora_fim: work.inicio });
  }
  if (timeToMinutes(work.fim) < timeToMinutes(salonEnd)) {
    bloqueios.push({ hora_inicio: work.fim, hora_fim: salonEnd });
  }

  const step = Math.max(Number(params.config.intervalo_minutos || 15), SLOT_STEP_MINUTES);
  const result: Array<{ horaInicio: string; horaFim: string }> = [];

  for (let current = timeToMinutes(salonStart); current < timeToMinutes(salonEnd); current += step) {
    const horaInicio = minutesToTime(current);
    const horaFim = addDurationToTime(horaInicio, params.duracao);
    const startsAt = new Date(`${params.data}T${horaInicio}:00`);
    if (Number.isFinite(startsAt.getTime()) && startsAt.getTime() < Date.now()) continue;
    if (timeToMinutes(horaFim) > timeToMinutes(salonEnd)) continue;

    const blocked = bloqueios.some((item) => overlaps(horaInicio, horaFim, item.hora_inicio, item.hora_fim));
    if (blocked) continue;

    const busy = params.agendamentos.some((item) => {
      if (params.ignoreAgendamentoId && text(item.id) === params.ignoreAgendamentoId) return false;
      const start = minutesToTime(Math.max(timeToMinutes(item.hora_inicio) - BUFFER_MINUTES, 0));
      const end = minutesToTime(timeToMinutes(item.hora_fim) + BUFFER_MINUTES);
      return overlaps(horaInicio, horaFim, start, end);
    });
    if (!busy) result.push({ horaInicio, horaFim });
  }

  return result;
}

async function canSalonAppear(idSalao: string) {
  const { data, error } = await getAdminClient()
    .from("saloes")
    .select("id,status,plano,trial_ativo,app_cliente_pausado")
    .eq("id", idSalao)
    .limit(1)
    .maybeSingle();

  throwIfSupabaseError(error, "Falha ao validar salão");
  if (!data?.id) return false;
  if (String(data.status || "").toLowerCase() !== "ativo") return false;
  if (data.app_cliente_pausado === true) return false;
  return Boolean(data.trial_ativo || ["pro", "premium"].includes(String(data.plano || "").toLowerCase()));
}

async function getAvailability(query: AnyRecord) {
  const idSalao = text(query.salao || query.id_salao || query.idSalao);
  const idServico = text(query.servico || query.id_servico || query.idServico);
  const idProfissional = text(query.profissional || query.id_profissional || query.idProfissional);
  const ignoreAgendamentoId = text(query.ignorar || query.ignore_agendamento_id) || null;
  const startParam = text(query.inicio || query.startDate) || null;

  if (!idSalao || !idServico || !idProfissional) {
    return { ok: false, error: "Escolha serviço e profissional para ver os horários disponíveis." };
  }
  if (!(await canSalonAppear(idSalao))) {
    return { ok: false, error: "Este salão não está publicado no app cliente agora." };
  }

  const supabase = getAdminClient();
  const [configResult, profissionalResult, servicoResult, vinculoResult] = await Promise.all([
    supabase
      .from("configuracoes_salao")
      .select("id_salao,hora_abertura,hora_fechamento,intervalo_minutos,dias_funcionamento")
      .eq("id_salao", idSalao)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("profissionais")
      .select("id,id_salao,nome,nome_exibicao,status,ativo,dias_trabalho,pausas,app_cliente_visivel,eh_assistente")
      .eq("id", idProfissional)
      .eq("id_salao", idSalao)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("servicos")
      .select("id,id_salao,nome,ativo,duracao,duracao_minutos,app_cliente_visivel")
      .eq("id", idServico)
      .eq("id_salao", idSalao)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("profissional_servicos")
      .select("id,duracao_minutos,ativo")
      .eq("id_salao", idSalao)
      .eq("id_profissional", idProfissional)
      .eq("id_servico", idServico)
      .eq("ativo", true)
      .limit(1)
      .maybeSingle(),
  ]);

  throwIfSupabaseError(configResult.error, "Falha ao carregar configuração");
  throwIfSupabaseError(profissionalResult.error, "Falha ao carregar profissional");
  throwIfSupabaseError(servicoResult.error, "Falha ao carregar serviço");
  throwIfSupabaseError(vinculoResult.error, "Falha ao carregar vínculo");

  if (!configResult.data?.id_salao) return { ok: false, error: "A agenda deste salão ainda não está configurada." };
  if (!profissionalResult.data?.id || profissionalResult.data.ativo === false || !profissionalResult.data.app_cliente_visivel || profissionalResult.data.eh_assistente === true) {
    return { ok: false, error: "Este profissional não está disponível no app cliente." };
  }
  if (!servicoResult.data?.id || servicoResult.data.ativo === false || !servicoResult.data.app_cliente_visivel) {
    return { ok: false, error: "Este serviço não está disponível no app cliente." };
  }
  if (!vinculoResult.data?.id) return { ok: false, error: "Este serviço não está vinculado ao profissional escolhido." };

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const requested = startParam ? new Date(`${startParam.slice(0, 10)}T12:00:00`) : todayStart;
  const startDate = Number.isNaN(requested.getTime()) || requested < todayStart ? todayStart : requested;
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + LOOKAHEAD_DAYS - 1);
  const dateFrom = formatDateString(startDate);
  const dateTo = formatDateString(endDate);

  const [bloqueiosResult, agendamentosResult] = await Promise.all([
    supabase
      .from("agenda_bloqueios")
      .select("id,id_salao,profissional_id,data,hora_inicio,hora_fim,motivo")
      .eq("id_salao", idSalao)
      .eq("profissional_id", idProfissional)
      .gte("data", dateFrom)
      .lte("data", dateTo),
    supabase
      .from("agendamentos")
      .select("id,data,hora_inicio,hora_fim,status")
      .eq("id_salao", idSalao)
      .eq("profissional_id", idProfissional)
      .gte("data", dateFrom)
      .lte("data", dateTo)
      .neq("status", "cancelado"),
  ]);

  throwIfSupabaseError(bloqueiosResult.error, "Falha ao carregar bloqueios");
  throwIfSupabaseError(agendamentosResult.error, "Falha ao carregar agendamentos");

  const bloqueiosByDate = new Map<string, AnyRecord[]>();
  for (const item of ((bloqueiosResult.data || []) as AnyRecord[])) {
    const date = text(item.data);
    bloqueiosByDate.set(date, [...(bloqueiosByDate.get(date) || []), item]);
  }
  const agendamentosByDate = new Map<string, AnyRecord[]>();
  for (const item of ((agendamentosResult.data || []) as AnyRecord[])) {
    const date = text(item.data);
    agendamentosByDate.set(date, [...(agendamentosByDate.get(date) || []), item]);
  }

  const duracao =
    Number(vinculoResult.data.duracao_minutos || 0) ||
    Number(servicoResult.data.duracao_minutos || servicoResult.data.duracao || 0) ||
    30;
  const dias: Array<{ data: string; rotulo: string; horarios: Array<{ horaInicio: string; horaFim: string }> }> = [];

  for (let offset = 0; offset < LOOKAHEAD_DAYS; offset += 1) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + offset);
    const data = formatDateString(date);
    const horarios = buildSlots({
      data,
      config: configResult.data as AnyRecord,
      profissional: profissionalResult.data as AnyRecord,
      duracao,
      bloqueios: bloqueiosByDate.get(data) || [],
      agendamentos: agendamentosByDate.get(data) || [],
      ignoreAgendamentoId,
    });
    if (horarios.length) {
      dias.push({
        data,
        rotulo: new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit" }).format(new Date(`${data}T12:00:00`)),
        horarios,
      });
    }
  }

  return {
    ok: true,
    provider: "oracle-vps",
    intervaloMinutos: Number(configResult.data.intervalo_minutos || 15),
    bufferMinutos: BUFFER_MINUTES,
    duracaoMinutos: duracao,
    dias,
  };
}

export async function registerClientAppRoutes(app: FastifyInstance) {
  app.get("/app-cliente/disponibilidade", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const result = await getAvailability((request.query || {}) as AnyRecord);
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  app.get("/app-cliente/saloes", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as AnyRecord;
    const supabase = getAdminClient();
    let builder = supabase
      .from("saloes")
      .select("id,nome,status,plano,trial_ativo,cidade,bairro,endereco,numero,telefone,whatsapp,latitude,longitude,slug_publico,logo_url,foto_capa_url,app_cliente_pausado,motivo_pausa_app_cliente,descricao_publica,created_at")
      .eq("status", "ativo")
      .or("trial_ativo.eq.true,plano.in.(pro,premium)")
      .neq("app_cliente_pausado", true)
      .order("nome", { ascending: true })
      .limit(limitFromQuery(query));

    if (text(query.busca)) builder = builder.ilike("nome", `%${text(query.busca)}%`);
    if (text(query.cidade)) builder = builder.ilike("cidade", `%${text(query.cidade)}%`);

    const { data, error } = await builder;
    throwIfSupabaseError(error, "Falha ao carregar salões do app cliente");
    return { ok: true, service: config.serviceName, provider: "oracle-vps", items: data || [] };
  });

  app.get("/app-cliente/saloes/:id", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const id = text((request.params as AnyRecord).id);
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("saloes")
      .select("id,nome,status,plano,trial_ativo,cidade,bairro,endereco,numero,telefone,whatsapp,latitude,longitude,slug_publico,logo_url,foto_capa_url,app_cliente_pausado,motivo_pausa_app_cliente,descricao_publica,created_at")
      .or(`id.eq.${id},slug_publico.eq.${id}`)
      .limit(1)
      .maybeSingle();
    throwIfSupabaseError(error, "Falha ao carregar salão");
    return { ok: Boolean(data?.id), service: config.serviceName, provider: "oracle-vps", item: data || null };
  });

  app.get("/app-cliente/saloes/:id/servicos", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const idSalao = text((request.params as AnyRecord).id);
    const query = (request.query || {}) as AnyRecord;
    const { data, error } = await getAdminClient()
      .from("servicos")
      .select("id,id_salao,nome,descricao,preco,duracao,duracao_minutos,ativo,app_cliente_visivel,categoria")
      .eq("id_salao", idSalao)
      .eq("ativo", true)
      .eq("app_cliente_visivel", true)
      .order("nome", { ascending: true })
      .limit(limitFromQuery(query, 50));
    throwIfSupabaseError(error, "Falha ao carregar serviços");
    return { ok: true, service: config.serviceName, provider: "oracle-vps", items: data || [] };
  });

  app.get("/app-cliente/saloes/:id/profissionais", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const idSalao = text((request.params as AnyRecord).id);
    const query = (request.query || {}) as AnyRecord;
    const { data, error } = await getAdminClient()
      .from("profissionais")
      .select("id,id_salao,nome,nome_exibicao,foto_url,categoria,cargo,status,ativo,app_cliente_visivel,eh_assistente,cor_agenda")
      .eq("id_salao", idSalao)
      .eq("ativo", true)
      .eq("app_cliente_visivel", true)
      .neq("eh_assistente", true)
      .order("nome", { ascending: true })
      .limit(limitFromQuery(query, 50));
    throwIfSupabaseError(error, "Falha ao carregar profissionais");
    return { ok: true, service: config.serviceName, provider: "oracle-vps", items: data || [] };
  });

  app.get("/app-cliente/agendamentos", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as AnyRecord;
    const idConta = text(query.cliente_app_conta_id || query.idConta);
    const idCliente = text(query.id_cliente || query.idCliente);
    const supabase = getAdminClient();

    let builder = supabase
      .from("agendamentos")
      .select("id,id_salao,cliente_id,profissional_id,servico_id,data,hora_inicio,hora_fim,status,origem,created_at,clientes(nome),profissionais(nome,nome_exibicao),servicos(nome,preco,duracao_minutos),saloes(nome,logo_url,slug_publico)")
      .order("data", { ascending: false })
      .order("hora_inicio", { ascending: false })
      .limit(limitFromQuery(query, 10, 50));

    if (idCliente) {
      builder = builder.eq("cliente_id", idCliente);
    } else if (idConta) {
      const { data: vinculos, error } = await supabase
        .from("clientes_auth")
        .select("id_cliente")
        .eq("app_conta_id", idConta)
        .eq("app_ativo", true);
      throwIfSupabaseError(error, "Falha ao carregar vínculos do cliente");
      const ids = ((vinculos || []) as AnyRecord[]).map((item) => text(item.id_cliente)).filter(Boolean);
      if (!ids.length) return { ok: true, service: config.serviceName, provider: "oracle-vps", items: [] };
      builder = builder.in("cliente_id", ids);
    }

    const { data, error } = await builder;
    throwIfSupabaseError(error, "Falha ao carregar agendamentos do app cliente");
    return { ok: true, service: config.serviceName, provider: "oracle-vps", items: data || [] };
  });
}
