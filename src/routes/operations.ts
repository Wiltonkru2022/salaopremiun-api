import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { requireAdminToken } from "../lib/auth.js";
import { findSubscriptionsForNotification, sendPushToRows, type NotificationJobRow } from "../lib/push.js";
import { appendNdjson, compactAllNdjsonFiles, createJob, createReprocessJob, files, readNdjson } from "../lib/store.js";
import { getSupabaseAdmin } from "../lib/supabase.js";

type AnyRecord = Record<string, unknown>;

type PeriodQuery = {
  id_salao?: string;
  idSalao?: string;
  inicio?: string;
  fim?: string;
  data_inicio?: string;
  data_fim?: string;
  limit?: string;
  status?: string;
};

type SupabaseErrorLike = { message?: string; details?: string; hint?: string };

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(2));
}

function sum(items: AnyRecord[], key: string): number {
  return roundMoney(items.reduce((acc, item) => acc + toNumber(item[key]), 0));
}

function countBy(items: AnyRecord[], key: string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const value = String(item[key] || "indefinido");
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function sumBy(items: AnyRecord[], groupKey: string, valueKey: string): Array<{ chave: string; total: number; quantidade: number }> {
  const grouped = items.reduce<Record<string, { total: number; quantidade: number }>>((acc, item) => {
    const key = String(item[groupKey] || "indefinido");
    if (!acc[key]) acc[key] = { total: 0, quantidade: 0 };
    acc[key].total += toNumber(item[valueKey]);
    acc[key].quantidade += 1;
    return acc;
  }, {});

  return Object.entries(grouped)
    .map(([chave, value]) => ({ chave, total: roundMoney(value.total), quantidade: value.quantidade }))
    .sort((a, b) => b.total - a.total);
}

function sumNestedItems(comandas: AnyRecord[]) {
  const items = comandas.flatMap((comanda) => {
    const nested = Array.isArray(comanda.comanda_itens) ? (comanda.comanda_itens as AnyRecord[]) : [];
    return nested.map((item) => ({ ...item, id_comanda: comanda.id, status_comanda: comanda.status }) as AnyRecord);
  });

  return {
    totalItens: items.length,
    servicos: items.filter((item) => String(item.tipo || "").toLowerCase() === "servico").length,
    produtos: items.filter((item) => String(item.tipo || "").toLowerCase() === "produto").length,
    extras: items.filter((item) => String(item.tipo || "").toLowerCase() === "extra").length,
    rankingServicos: sumBy(
      items.filter((item) => String(item.tipo || "").toLowerCase() === "servico"),
      "descricao",
      "valor_total",
    ).slice(0, 20),
    rankingProdutos: sumBy(
      items.filter((item) => String(item.tipo || "").toLowerCase() === "produto"),
      "descricao",
      "valor_total",
    ).slice(0, 20),
  };
}

function limitFromQuery(query: PeriodQuery, fallback = 500, max = 1000): number {
  const parsed = Number(query.limit || fallback);
  return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : fallback, max);
}

function getPeriod(query: PeriodQuery) {
  const end = query.fim || query.data_fim || new Date().toISOString();
  const start =
    query.inicio ||
    query.data_inicio ||
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  return {
    inicio: new Date(start).toISOString(),
    fim: new Date(end).toISOString(),
  };
}

function requireSalao(payload: AnyRecord) {
  const idSalao = String(payload.id_salao || payload.idSalao || "").trim();
  if (!idSalao) {
    const error = new Error("id_salao é obrigatório para esta operação.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return idSalao;
}

function getAdminClient() {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    const error = new Error("Supabase da VPS não configurado. Informe SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env da API.");
    (error as Error & { statusCode?: number }).statusCode = 503;
    throw error;
  }
  return supabase;
}

function throwIfSupabaseError(error: SupabaseErrorLike | null, label: string) {
  if (!error) return;
  const err = new Error(`${label}: ${error.message || "erro desconhecido"}`);
  (err as Error & { statusCode?: number; details?: unknown }).statusCode = 502;
  (err as Error & { details?: unknown }).details = error;
  throw err;
}

async function fetchComandas(idSalao: string, query: PeriodQuery, dateColumn = "fechada_em") {
  const supabase = getAdminClient();
  const period = getPeriod(query);
  let builder = supabase
    .from("comandas")
    .select("id,id_salao,numero,status,subtotal,desconto,acrescimo,total,aberta_em,fechada_em,cancelada_em,created_at,updated_at,comanda_itens(id,tipo,descricao,quantidade,valor_unitario,valor_total,id_profissional)")
    .eq("id_salao", idSalao)
    .gte(dateColumn, period.inicio)
    .lte(dateColumn, period.fim)
    .order(dateColumn, { ascending: false })
    .limit(limitFromQuery(query));

  if (query.status) builder = builder.eq("status", query.status);

  const { data, error } = await builder;
  throwIfSupabaseError(error, "Falha ao carregar comandas");
  return { rows: (data || []) as AnyRecord[], period };
}

async function fetchPagamentos(idSalao: string, query: PeriodQuery) {
  const supabase = getAdminClient();
  const period = getPeriod(query);
  const { data, error } = await supabase
    .from("comanda_pagamentos")
    .select("id,id_salao,id_comanda,forma_pagamento,valor,taxa,taxa_maquininha_valor,valor_troco,valor_credito_cliente,pago_em,created_at")
    .eq("id_salao", idSalao)
    .gte("created_at", period.inicio)
    .lte("created_at", period.fim)
    .order("created_at", { ascending: false })
    .limit(limitFromQuery(query));

  throwIfSupabaseError(error, "Falha ao carregar pagamentos");
  return ((data || []) as AnyRecord[]);
}

async function fetchComissoes(idSalao: string, query: PeriodQuery) {
  const supabase = getAdminClient();
  const period = getPeriod(query);
  let builder = supabase
    .from("comissoes_lancamentos")
    .select("id,id_salao,id_comanda,id_profissional,id_assistente,tipo_destinatario,descricao,percentual_aplicado,valor_base,valor_comissao,valor_comissao_assistente,status,competencia_data,pago_em,criado_em")
    .eq("id_salao", idSalao)
    .gte("competencia_data", period.inicio.slice(0, 10))
    .lte("competencia_data", period.fim.slice(0, 10))
    .order("competencia_data", { ascending: false })
    .limit(limitFromQuery(query));

  if (query.status) builder = builder.eq("status", query.status);

  const { data, error } = await builder;
  throwIfSupabaseError(error, "Falha ao carregar comissões");
  return ((data || []) as AnyRecord[]);
}

async function fetchCaixaMovimentacoes(idSalao: string, query: PeriodQuery) {
  const supabase = getAdminClient();
  const period = getPeriod(query);
  const { data, error } = await supabase
    .from("caixa_movimentacoes")
    .select("id,id_salao,id_sessao,id_comanda,id_profissional,tipo,forma_pagamento,valor,descricao,created_at")
    .eq("id_salao", idSalao)
    .gte("created_at", period.inicio)
    .lte("created_at", period.fim)
    .order("created_at", { ascending: false })
    .limit(limitFromQuery(query));

  throwIfSupabaseError(error, "Falha ao carregar movimentações de caixa");
  return ((data || []) as AnyRecord[]);
}

function buildVendasResumo(comandas: AnyRecord[], pagamentos: AnyRecord[]) {
  const fechadas = comandas.filter((item) => String(item.status || "").toLowerCase() === "fechada");
  const canceladas = comandas.filter((item) => String(item.status || "").toLowerCase() === "cancelada");

  return {
    totalVendas: fechadas.length,
    canceladas: canceladas.length,
    bruto: sum(fechadas, "subtotal"),
    descontos: sum(fechadas, "desconto"),
    acrescimos: sum(fechadas, "acrescimo"),
    liquido: sum(fechadas, "total"),
    recebido: sum(pagamentos, "valor"),
    troco: sum(pagamentos, "valor_troco"),
    creditoCliente: sum(pagamentos, "valor_credito_cliente"),
    taxaMaquininha: roundMoney(sum(pagamentos, "taxa") + sum(pagamentos, "taxa_maquininha_valor")),
    porStatus: countBy(comandas, "status"),
    porFormaPagamento: sumBy(pagamentos, "forma_pagamento", "valor"),
  };
}

function buildComissoesResumo(comissoes: AnyRecord[]) {
  const pendentes = comissoes.filter((item) => String(item.status || "").toLowerCase() === "pendente");
  const pagas = comissoes.filter((item) => String(item.status || "").toLowerCase() === "pago");
  const canceladas = comissoes.filter((item) => String(item.status || "").toLowerCase() === "cancelado");

  return {
    totalLancamentos: comissoes.length,
    pendentes: pendentes.length,
    pagas: pagas.length,
    canceladas: canceladas.length,
    valorTotal: sum(comissoes, "valor_comissao"),
    valorPendente: sum(pendentes, "valor_comissao"),
    valorPago: sum(pagas, "valor_comissao"),
    porStatus: countBy(comissoes, "status"),
    porProfissional: sumBy(comissoes, "id_profissional", "valor_comissao").slice(0, 20),
  };
}

async function markNotificationJob(
  id: string,
  status: "processando" | "enviada" | "falhou",
  extra?: Record<string, unknown>,
) {
  await getAdminClient()
    .from("notification_jobs")
    .update({
      status,
      updated_at: new Date().toISOString(),
      ...(extra || {}),
    })
    .eq("id", id);
}

async function processNotificationJobs(limit: number) {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from("notification_jobs")
    .select("id,id_salao,id_cliente,id_profissional,cliente_app_conta_id,canal,tipo,titulo,mensagem,url,tag,status,enviar_em,tentativas,idempotency_key")
    .eq("status", "pendente")
    .lte("enviar_em", new Date().toISOString())
    .order("enviar_em", { ascending: true })
    .limit(limit);

  throwIfSupabaseError(error, "Falha ao buscar notificações pendentes");

  const rows = (data || []) as NotificationJobRow[];
  let processed = 0;
  let sent = 0;
  let failed = 0;
  let inactive = 0;

  for (const job of rows) {
    const lock = await supabase
      .from("notification_jobs")
      .update({
        status: "processando",
        tentativas: Number(job.tentativas || 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("status", "pendente")
      .select("id")
      .maybeSingle();

    if (lock.error || !lock.data?.id) continue;

    try {
      const subscriptions = await findSubscriptionsForNotification(job);
      const result = await sendPushToRows(subscriptions, {
        title: job.titulo,
        body: job.mensagem,
        url: job.url || "/",
        tag: job.tag || job.idempotency_key || job.id,
      });

      await markNotificationJob(job.id, "enviada", {
        enviada_em: new Date().toISOString(),
        sent_count: result.sent,
        erro_texto: null,
      });
      appendNdjson(files.notifications, {
        type: "notifications:processed",
        status: "sent",
        id_notification_job: job.id,
        sent: result.sent,
        failed: result.failed,
        inactive: result.inactive,
      });
      processed += 1;
      sent += result.sent;
      inactive += result.inactive;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erro ao enviar notificação.";
      await markNotificationJob(job.id, "falhou", { erro_texto: message });
      createReprocessJob("notification", { id: job.id, job }, message);
      failed += 1;
    }
  }

  return { processed, sent, failed, inactive, scanned: rows.length };
}

export async function registerOperationRoutes(app: FastifyInstance) {
  app.get("/caixa", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as PeriodQuery;
    const idSalao = requireSalao(query as AnyRecord);
    const [movimentacoes, sessoesResult] = await Promise.all([
      fetchCaixaMovimentacoes(idSalao, query),
      getAdminClient()
        .from("caixa_sessoes")
        .select("id,id_salao,status,valor_abertura,valor_fechamento_informado,aberto_em,fechado_em")
        .eq("id_salao", idSalao)
        .order("aberto_em", { ascending: false })
        .limit(20),
    ]);

    throwIfSupabaseError(sessoesResult.error, "Falha ao carregar sessões de caixa");

    return {
      ok: true,
      service: config.serviceName,
      id_salao: idSalao,
      resumo: {
        movimentacoes: movimentacoes.length,
        entrada: sum(movimentacoes.filter((item) => ["venda", "suprimento"].includes(String(item.tipo))), "valor"),
        saida: sum(movimentacoes.filter((item) => ["sangria", "vale_profissional"].includes(String(item.tipo))), "valor"),
        porTipo: countBy(movimentacoes, "tipo"),
        porFormaPagamento: sumBy(movimentacoes, "forma_pagamento", "valor"),
      },
      sessoes: sessoesResult.data || [],
      items: movimentacoes.slice(0, 50),
      generatedAt: new Date().toISOString(),
    };
  });

  app.get("/caixa/resumo", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as PeriodQuery;
    const idSalao = requireSalao(query as AnyRecord);
    const movimentacoes = await fetchCaixaMovimentacoes(idSalao, query);
    return {
      ok: true,
      service: config.serviceName,
      total: movimentacoes.length,
      resumo: {
        totalMovimentado: sum(movimentacoes, "valor"),
        porTipo: countBy(movimentacoes, "tipo"),
        porFormaPagamento: sumBy(movimentacoes, "forma_pagamento", "valor"),
      },
      items: movimentacoes.slice(0, 20),
    };
  });

  app.post("/caixa/fechar", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = asRecord(request.body);
    const idSalao = requireSalao(payload);
    const valorInformado = toNumber(payload.valor_fechamento_informado || payload.valorFechamentoInformado || payload.valor_fechamento);
    const movimentacoes = await fetchCaixaMovimentacoes(idSalao, { id_salao: idSalao, limit: "1000" });
    const entrada = sum(movimentacoes.filter((item) => ["venda", "suprimento"].includes(String(item.tipo))), "valor");
    const saida = sum(movimentacoes.filter((item) => ["sangria", "vale_profissional"].includes(String(item.tipo))), "valor");
    const previsto = roundMoney(entrada - saida);
    const diferenca = roundMoney(valorInformado - previsto);

    const record = appendNdjson(files.caixa, {
      type: "caixa:fechar:calculo",
      status: "calculated",
      id_salao: idSalao,
      id_sessao: payload.id_sessao || payload.idSessao || null,
      valor_informado: valorInformado,
      previsto,
      diferenca,
      entrada,
      saida,
      payload,
    });

    return reply.code(202).send({ ok: true, service: config.serviceName, fechamento: record });
  });

  app.get("/comissoes", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as PeriodQuery;
    const idSalao = requireSalao(query as AnyRecord);
    const comissoes = await fetchComissoes(idSalao, query);
    return {
      ok: true,
      service: config.serviceName,
      id_salao: idSalao,
      resumo: buildComissoesResumo(comissoes),
      items: comissoes.slice(0, 100),
      generatedAt: new Date().toISOString(),
    };
  });

  app.post("/comissoes/calcular", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = asRecord(request.body);
    const idSalao = requireSalao(payload);
    const itens = Array.isArray(payload.itens) ? (payload.itens as AnyRecord[]) : [];
    const calculos = (itens.length ? itens : [payload]).map((item) => {
      const base = toNumber(item.valor_base || item.valorBase || item.valor_total || item.valorTotal);
      const percentual = toNumber(item.percentual || item.percentual_aplicado || item.comissao_percentual || item.comissaoPercentual);
      return {
        id_item: item.id || item.id_comanda_item || null,
        id_profissional: item.id_profissional || null,
        descricao: item.descricao || null,
        valor_base: roundMoney(base),
        percentual: roundMoney(percentual),
        valor_comissao: roundMoney((base * percentual) / 100),
      };
    });

    const record = appendNdjson(files.comissoes, {
      type: "comissoes:calcular",
      status: "completed",
      id_salao: idSalao,
      total_calculos: calculos.length,
      valor_base: roundMoney(calculos.reduce((acc, item) => acc + item.valor_base, 0)),
      valor_comissao: roundMoney(calculos.reduce((acc, item) => acc + item.valor_comissao, 0)),
      calculos,
      payload,
    });

    return { ok: true, service: config.serviceName, calculo: record };
  });

  app.get("/vendas", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as PeriodQuery;
    const idSalao = requireSalao(query as AnyRecord);
    const [comandasData, pagamentos] = await Promise.all([fetchComandas(idSalao, query), fetchPagamentos(idSalao, query)]);
    return {
      ok: true,
      service: config.serviceName,
      id_salao: idSalao,
      periodo: comandasData.period,
      resumo: buildVendasResumo(comandasData.rows, pagamentos),
      itens: sumNestedItems(comandasData.rows),
      items: comandasData.rows.slice(0, 100),
      generatedAt: new Date().toISOString(),
    };
  });

  app.get("/vendas/resumo", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as PeriodQuery;
    const idSalao = requireSalao(query as AnyRecord);
    const [comandasData, pagamentos] = await Promise.all([fetchComandas(idSalao, query), fetchPagamentos(idSalao, query)]);
    return { ok: true, service: config.serviceName, resumo: buildVendasResumo(comandasData.rows, pagamentos), itens: sumNestedItems(comandasData.rows) };
  });

  app.get("/relatorio-financeiro", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as PeriodQuery;
    const idSalao = requireSalao(query as AnyRecord);
    const [comandasData, pagamentos, comissoes, movimentacoes] = await Promise.all([
      fetchComandas(idSalao, query),
      fetchPagamentos(idSalao, query),
      fetchComissoes(idSalao, query),
      fetchCaixaMovimentacoes(idSalao, query),
    ]);
    const vendas = buildVendasResumo(comandasData.rows, pagamentos);
    const comissoesResumo = buildComissoesResumo(comissoes);
    const lucroEstimado = roundMoney(vendas.liquido - vendas.taxaMaquininha - comissoesResumo.valorTotal);

    const report = {
      id_salao: idSalao,
      periodo: comandasData.period,
      vendas,
      itens: sumNestedItems(comandasData.rows),
      comissoes: comissoesResumo,
      caixa: {
        totalMovimentado: sum(movimentacoes, "valor"),
        porTipo: countBy(movimentacoes, "tipo"),
        porFormaPagamento: sumBy(movimentacoes, "forma_pagamento", "valor"),
      },
      lucroEstimado,
      generatedAt: new Date().toISOString(),
    };

    appendNdjson(files.reports, { type: "relatorio-financeiro", status: "completed", ...report });
    return { ok: true, service: config.serviceName, relatorio: report };
  });

  app.get("/relatorios/vendas", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as PeriodQuery;
    const idSalao = String(query.id_salao || query.idSalao || "").trim();
    if (!idSalao) {
      const caixa = readNdjson(files.caixa, 200);
      return {
        ok: true,
        service: config.serviceName,
        relatorio: { tipo: "vendas", totalRegistros: caixa.length, geradoEm: new Date().toISOString() },
      };
    }
    const [comandasData, pagamentos] = await Promise.all([fetchComandas(idSalao, query), fetchPagamentos(idSalao, query)]);
    return { ok: true, service: config.serviceName, relatorio: { tipo: "vendas", ...buildVendasResumo(comandasData.rows, pagamentos), geradoEm: new Date().toISOString() } };
  });

  app.get("/relatorios/profissionais", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as PeriodQuery;
    const idSalao = String(query.id_salao || query.idSalao || "").trim();
    if (!idSalao) {
      const comissoes = readNdjson(files.comissoes, 200);
      return { ok: true, service: config.serviceName, relatorio: { tipo: "profissionais", totalCalculos: comissoes.length, geradoEm: new Date().toISOString() } };
    }
    const comissoes = await fetchComissoes(idSalao, query);
    return { ok: true, service: config.serviceName, relatorio: { tipo: "profissionais", ...buildComissoesResumo(comissoes), geradoEm: new Date().toISOString() } };
  });

  app.get("/notificacoes", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = (request.query || {}) as PeriodQuery;
    const idSalao = String(query.id_salao || query.idSalao || "").trim();
    const supabase = getAdminClient();
    let builder = supabase
      .from("notification_jobs")
      .select("id,id_salao,id_cliente,id_profissional,cliente_app_conta_id,canal,tipo,titulo,mensagem,url,tag,status,enviar_em,enviada_em,tentativas,sent_count,erro_texto,created_at")
      .order("enviar_em", { ascending: false })
      .limit(limitFromQuery(query, 100));
    if (idSalao) builder = builder.eq("id_salao", idSalao);
    if (query.status) builder = builder.eq("status", query.status);
    const { data, error } = await builder;
    throwIfSupabaseError(error, "Falha ao carregar notificações");
    const items = (data || []) as AnyRecord[];
    return { ok: true, service: config.serviceName, resumo: { total: items.length, porStatus: countBy(items, "status"), porCanal: countBy(items, "canal") }, items };
  });

  app.post("/notificacoes/enviar", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = asRecord(request.body);
    const job = createJob("notifications:send", payload || null, "queued");
    appendNdjson(files.notifications, { type: "notifications:send", status: "queued", payload });
    return reply.code(202).send({ ok: true, service: config.serviceName, job, note: "Job enfileirado na VPS. O envio final deve ser idempotente para não duplicar push/e-mail." });
  });

  app.post("/notificacoes/processar", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = asRecord(request.body);
    const limit = Math.min(toNumber(payload.limit || 50), 100);
    const result = await processNotificationJobs(limit);
    const job = createJob("notifications:process", { requested: payload, result }, "completed");
    return reply.code(202).send({ ok: true, service: config.serviceName, job, ...result });
  });

  app.post("/backup/executar", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = asRecord(request.body);
    const supabase = getAdminClient();
    const tables = ["saloes", "usuarios", "comandas", "comanda_itens", "comanda_pagamentos", "comissoes_lancamentos", "caixa_sessoes", "caixa_movimentacoes", "notification_jobs"];
    const counts: Record<string, number | null> = {};

    for (const table of tables) {
      const { count, error } = await supabase.from(table).select("id", { count: "exact", head: true });
      counts[table] = error ? null : count;
    }

    const job = createJob("backup:metadata", { mode: payload.mode || "metadata_only", counts }, "completed");
    appendNdjson(files.backups, { type: "backup:metadata", status: "completed", counts });
    return reply.code(202).send({ ok: true, service: config.serviceName, job, backup: { mode: "metadata_only", counts, generatedAt: new Date().toISOString() } });
  });

  app.get("/backup", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    return { ok: true, service: config.serviceName, items: readNdjson(files.backups, 20) };
  });

  app.post("/jobs/cleanup", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const result = compactAllNdjsonFiles();
    const job = createJob("cleanup:ndjson", { result }, "completed");
    appendNdjson(files.cleanup, { type: "cleanup:ndjson", status: "completed", result });
    return reply.code(202).send({ ok: true, service: config.serviceName, job, result });
  });

  app.get("/admin/reprocess", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    return { ok: true, service: config.serviceName, items: readNdjson(files.reprocess, 100) };
  });
}
