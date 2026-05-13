import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { requireAdminToken } from "../lib/auth.js";
import { getSupabaseAdmin } from "../lib/supabase.js";

type AnyRecord = Record<string, unknown>;

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

function text(value: unknown, maxLength = 2000) {
  return String(value || "").trim().slice(0, maxLength);
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function limitFromQuery(query: AnyRecord, fallback = 20, max = 100) {
  const parsed = Number(query.limit || fallback);
  return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : fallback, max);
}

function contextFromPayload(payload: AnyRecord) {
  return {
    idSalao: text(payload.id_salao || payload.idSalao),
    idProfissional: text(payload.id_profissional || payload.idProfissional),
    nome: text(payload.nome || payload.profissional_nome, 180) || "Profissional",
    email: text(payload.email || payload.profissional_email, 220) || null,
  };
}

function contextFromQuery(query: AnyRecord) {
  return {
    idSalao: text(query.id_salao || query.idSalao),
    idProfissional: text(query.id_profissional || query.idProfissional),
  };
}

function requireProfessionalContext(payload: AnyRecord) {
  const context = contextFromPayload(payload);
  if (!context.idSalao || !context.idProfissional) {
    const error = new Error("Contexto do profissional obrigatório.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return context;
}

async function listNotifications(query: AnyRecord) {
  const context = contextFromQuery(query);
  if (!context.idSalao || !context.idProfissional) return [];

  const supabase = getAdminClient();
  const { data: tickets, error: ticketsError } = await supabase
    .from("tickets")
    .select("id,numero,origem_contexto")
    .eq("id_salao", context.idSalao)
    .eq("origem", "app_profissional_login")
    .order("atualizado_em", { ascending: false })
    .limit(20);
  throwIfSupabaseError(ticketsError, "Falha ao carregar tickets do profissional");

  const ownedTickets = ((tickets || []) as AnyRecord[]).filter((ticket) => {
    const origemContexto = asRecord(ticket.origem_contexto);
    return text(origemContexto.id_profissional) === context.idProfissional;
  });
  if (!ownedTickets.length) return [];

  const ticketMap = new Map(ownedTickets.map((ticket) => [text(ticket.id), Number(ticket.numero || 0)]));
  const { data: eventos, error: eventosError } = await supabase
    .from("ticket_eventos")
    .select("id,id_ticket,evento,descricao,payload_json,criado_em")
    .in("id_ticket", ownedTickets.map((ticket) => text(ticket.id)))
    .eq("evento", "senha_redefinida_salao")
    .order("criado_em", { ascending: false })
    .limit(limitFromQuery(query, 5, 20));
  throwIfSupabaseError(eventosError, "Falha ao carregar eventos de ticket");

  return ((eventos || []) as AnyRecord[]).map((evento) => {
    const payload = asRecord(evento.payload_json);
    const nomeSalao = text(payload.nome_salao, 120) || "seu salão";
    const numeroTicket = ticketMap.get(text(evento.id_ticket));
    return {
      id: text(evento.id),
      title: "Senha alterada pelo salão",
      description:
        text(evento.descricao, 300) ||
        `O salão ${nomeSalao} redefiniu sua senha de acesso ao app profissional.`,
      createdAt: text(evento.criado_em) || null,
      actionLabel: numeroTicket ? `Ticket #${numeroTicket}` : "Ver notificação",
      href: `/app-profissional/notificacoes?notificacao=${encodeURIComponent(text(evento.id))}`,
    };
  });
}

async function loadProfessionalSummary(idSalao: string, idProfissional: string) {
  const supabase = getAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const startMonth = `${today.slice(0, 8)}01`;
  const [profissional, agendaHoje, comandasMes, comissoes] = await Promise.all([
    supabase
      .from("profissionais")
      .select("id,nome,nome_exibicao,categoria,cargo,ativo,status")
      .eq("id", idProfissional)
      .eq("id_salao", idSalao)
      .maybeSingle(),
    supabase
      .from("agendamentos")
      .select("id,data,hora_inicio,hora_fim,status,cliente_id,servico_id,id_comanda,clientes(nome),servicos(nome,preco,duracao_minutos)")
      .eq("id_salao", idSalao)
      .eq("profissional_id", idProfissional)
      .eq("data", today)
      .order("hora_inicio", { ascending: true })
      .limit(20),
    supabase
      .from("comanda_itens")
      .select("id,id_comanda,id_profissional,id_assistente,descricao,valor_total,created_at")
      .eq("id_salao", idSalao)
      .or(`id_profissional.eq.${idProfissional},id_assistente.eq.${idProfissional}`)
      .gte("created_at", `${startMonth}T00:00:00`)
      .limit(100),
    supabase
      .from("comissoes_lancamentos")
      .select("id,valor_comissao,status,competencia_data")
      .eq("id_salao", idSalao)
      .eq("id_profissional", idProfissional)
      .gte("competencia_data", startMonth)
      .limit(100),
  ]);

  throwIfSupabaseError(profissional.error, "Falha ao carregar profissional");
  throwIfSupabaseError(agendaHoje.error, "Falha ao carregar agenda do profissional");
  throwIfSupabaseError(comandasMes.error, "Falha ao carregar vendas do profissional");
  throwIfSupabaseError(comissoes.error, "Falha ao carregar comissões do profissional");

  const totalVendidoMes = ((comandasMes.data || []) as AnyRecord[]).reduce((acc, item) => acc + Number(item.valor_total || 0), 0);
  const totalComissaoMes = ((comissoes.data || []) as AnyRecord[]).reduce((acc, item) => acc + Number(item.valor_comissao || 0), 0);

  return {
    profissional: profissional.data || null,
    agendaHoje: agendaHoje.data || [],
    resumo: {
      agendaHoje: (agendaHoje.data || []).length,
      vendidoMes: Number(totalVendidoMes.toFixed(2)),
      comissaoMes: Number(totalComissaoMes.toFixed(2)),
    },
  };
}

async function findOrCreateConversation(params: {
  idSalao: string;
  idProfissional: string;
  origemPagina?: string | null;
  idComanda?: string | null;
  idAgendamento?: string | null;
  idCliente?: string | null;
}) {
  const supabase = getAdminClient();
  let query = supabase
    .from("suporte_conversas")
    .select("id,id_salao,id_profissional,origem_pagina,id_comanda,id_agendamento,id_cliente,titulo,atualizado_em")
    .eq("id_salao", params.idSalao)
    .eq("id_profissional", params.idProfissional)
    .order("atualizado_em", { ascending: false })
    .limit(1);

  query = params.origemPagina ? query.eq("origem_pagina", params.origemPagina) : query.is("origem_pagina", null);
  query = params.idComanda ? query.eq("id_comanda", params.idComanda) : query.is("id_comanda", null);
  query = params.idAgendamento ? query.eq("id_agendamento", params.idAgendamento) : query.is("id_agendamento", null);
  query = params.idCliente ? query.eq("id_cliente", params.idCliente) : query.is("id_cliente", null);

  const found = await query.maybeSingle();
  throwIfSupabaseError(found.error, "Falha ao buscar conversa");
  if (found.data?.id) return found.data as AnyRecord;

  const created = await supabase
    .from("suporte_conversas")
    .insert({
      id_salao: params.idSalao,
      id_profissional: params.idProfissional,
      origem_pagina: params.origemPagina || null,
      id_comanda: params.idComanda || null,
      id_agendamento: params.idAgendamento || null,
      id_cliente: params.idCliente || null,
      titulo: "Suporte do app",
      atualizado_em: new Date().toISOString(),
    })
    .select("id,id_salao,id_profissional,origem_pagina,id_comanda,id_agendamento,id_cliente,titulo,atualizado_em")
    .single();
  throwIfSupabaseError(created.error, "Falha ao criar conversa");
  return created.data as AnyRecord;
}

async function saveSupportMessage(params: {
  idConversa: string;
  papel: "user" | "assistant";
  conteudo: string;
}) {
  const supabase = getAdminClient();
  const { error } = await supabase.from("suporte_mensagens").insert({
    id_conversa: params.idConversa,
    papel: params.papel,
    conteudo: params.conteudo,
    metadados: { provider: "oracle-vps" },
  });
  throwIfSupabaseError(error, "Falha ao salvar mensagem de suporte");
  await supabase
    .from("suporte_conversas")
    .update({ atualizado_em: new Date().toISOString() })
    .eq("id", params.idConversa);
}

function buildSupportAnswer(message: string, summary: Awaited<ReturnType<typeof loadProfessionalSummary>>) {
  const msg = message.toLowerCase();
  if (["criar agendamento", "cadastrar cliente", "trocar senha", "alterar comanda"].some((term) => msg.includes(term))) {
    return "Eu posso te orientar, mas não executo ações no sistema. Use a tela correta do app para criar agendamentos, cadastrar clientes, alterar comandas ou redefinir senha com segurança.";
  }

  const nome = text((summary.profissional as AnyRecord | null)?.nome_exibicao || (summary.profissional as AnyRecord | null)?.nome, 80) || "profissional";
  return [
    `Oi, ${nome}. Consultei seu contexto na VPS.`,
    `Hoje você tem ${summary.resumo.agendaHoje} atendimento(s) na agenda.`,
    `Neste mês, seus itens vinculados somam R$ ${summary.resumo.vendidoMes.toFixed(2)} e suas comissões registradas somam R$ ${summary.resumo.comissaoMes.toFixed(2)}.`,
    "Se quiser, abra um ticket humano nessa tela para um atendimento mais detalhado.",
  ].join("\n");
}

export async function registerProfessionalAppRoutes(app: FastifyInstance) {
  app.get("/app-profissional/notificacoes", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const notifications = await listNotifications((request.query || {}) as AnyRecord);
    return { ok: true, service: config.serviceName, provider: "oracle-vps", notifications };
  });

  app.get("/app-profissional/agenda", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as AnyRecord;
    const context = contextFromQuery(query);
    if (!context.idSalao || !context.idProfissional) {
      return reply.code(400).send({ ok: false, error: "Contexto do profissional obrigatório." });
    }
    const data = text(query.data) || new Date().toISOString().slice(0, 10);
    const { data: rows, error } = await getAdminClient()
      .from("agendamentos")
      .select("id,id_salao,cliente_id,profissional_id,servico_id,data,hora_inicio,hora_fim,status,id_comanda,clientes(nome),servicos(nome,preco,duracao_minutos)")
      .eq("id_salao", context.idSalao)
      .eq("profissional_id", context.idProfissional)
      .eq("data", data)
      .order("hora_inicio", { ascending: true })
      .limit(limitFromQuery(query, 50));
    throwIfSupabaseError(error, "Falha ao carregar agenda do app profissional");
    return { ok: true, service: config.serviceName, provider: "oracle-vps", items: rows || [] };
  });

  app.get("/app-profissional/resumo", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const context = contextFromQuery((request.query || {}) as AnyRecord);
    if (!context.idSalao || !context.idProfissional) {
      return reply.code(400).send({ ok: false, error: "Contexto do profissional obrigatório." });
    }
    const summary = await loadProfessionalSummary(context.idSalao, context.idProfissional);
    return { ok: true, service: config.serviceName, provider: "oracle-vps", ...summary };
  });

  app.post("/app-profissional/suporte", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = asRecord(request.body);
    const context = requireProfessionalContext(payload);
    const message = text(payload.message, 900);
    if (!message) return reply.code(400).send({ error: "Digite uma mensagem." });

    const conversa = await findOrCreateConversation({
      idSalao: context.idSalao,
      idProfissional: context.idProfissional,
      origemPagina: text(payload.origemPagina, 100) || null,
      idComanda: text(payload.idComanda, 80) || null,
      idAgendamento: text(payload.idAgendamento, 80) || null,
      idCliente: text(payload.idCliente, 80) || null,
    });

    await saveSupportMessage({ idConversa: text(conversa.id), papel: "user", conteudo: message });
    const summary = await loadProfessionalSummary(context.idSalao, context.idProfissional);
    const answer = buildSupportAnswer(message, summary);
    await saveSupportMessage({ idConversa: text(conversa.id), papel: "assistant", conteudo: answer });

    return { answer, conversaId: conversa.id, provider: "oracle-vps" };
  });

  app.post("/app-profissional/suporte/finalizar", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = asRecord(request.body);
    const context = requireProfessionalContext(payload);
    const conversaId = text(payload.conversaId);
    if (!conversaId) return reply.code(400).send({ error: "Conversa não informada." });

    const { error } = await getAdminClient()
      .from("suporte_conversas")
      .delete()
      .eq("id", conversaId)
      .eq("id_salao", context.idSalao)
      .eq("id_profissional", context.idProfissional);
    throwIfSupabaseError(error, "Falha ao finalizar chat");
    return { ok: true, provider: "oracle-vps" };
  });

  app.post("/app-profissional/tickets", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = asRecord(request.body);
    const context = requireProfessionalContext(payload);
    const assunto = text(payload.assunto, 220);
    const mensagem = text(payload.mensagem, 3000);
    if (!assunto || !mensagem) {
      return reply.code(400).send({ ok: false, error: "Preencha assunto e mensagem para abrir o ticket." });
    }

    const now = new Date().toISOString();
    const supabase = getAdminClient();
    const created = await supabase
      .from("tickets")
      .insert({
        id_salao: context.idSalao,
        assunto,
        categoria: text(payload.categoria, 80) || "suporte",
        prioridade: text(payload.prioridade, 80) || "media",
        status: "aberto",
        origem: "app_profissional",
        solicitante_nome: context.nome,
        solicitante_email: context.email,
        origem_contexto: {
          ...(asRecord(payload.contexto) || {}),
          origem: "app_profissional",
          id_profissional: context.idProfissional,
          provider: "oracle-vps",
        },
        ultima_interacao_em: now,
        atualizado_em: now,
      })
      .select("id,numero,status")
      .single();
    throwIfSupabaseError(created.error, "Falha ao abrir ticket");
    if (!created.data?.id) {
      const error = new Error("Falha ao abrir ticket: retorno vazio.");
      (error as Error & { statusCode?: number }).statusCode = 502;
      throw error;
    }

    const message = await supabase.from("ticket_mensagens").insert({
      id_ticket: created.data.id,
      autor_tipo: "profissional",
      autor_nome: context.nome,
      mensagem,
      interna: false,
      id_profissional: context.idProfissional,
    });
    throwIfSupabaseError(message.error, "Falha ao registrar mensagem do ticket");

    await supabase.from("ticket_eventos").insert({
      id_ticket: created.data.id,
      evento: "ticket_aberto",
      descricao: "Ticket aberto pelo app profissional via VPS.",
      payload_json: { origem: "app_profissional", provider: "oracle-vps" },
    });

    return {
      ok: true,
      provider: "oracle-vps",
      ticket: {
        id: String(created.data.id),
        numero: Number(created.data.numero || 0),
        status: String(created.data.status || "aberto"),
      },
    };
  });
}
