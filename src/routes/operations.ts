import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { requireAdminToken } from "../lib/auth.js";
import { appendNdjson, createJob, files, readNdjson } from "../lib/store.js";

function requireSalao(payload: Record<string, unknown>) {
  const idSalao = String(payload.id_salao || payload.idSalao || "").trim();
  if (!idSalao) {
    const error = new Error("id_salao e obrigatorio para esta operacao.");
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
  return idSalao;
}

export async function registerOperationRoutes(app: FastifyInstance) {
  app.post("/caixa/fechar", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = (request.body || {}) as Record<string, unknown>;
    const idSalao = requireSalao(payload);
    const record = appendNdjson(files.caixa, {
      type: "caixa:fechar",
      status: "simulated",
      id_salao: idSalao,
      note: "Endpoint preparado. Fechamento real deve ser ativado apos comparacao com o painel principal.",
      payload,
    });
    return reply.code(202).send({ ok: true, service: config.serviceName, fechamento: record });
  });

  app.get("/caixa/resumo", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = request.query as { id_salao?: string } | undefined;
    const items = readNdjson(files.caixa, 100).filter((item) => !query?.id_salao || item.id_salao === query.id_salao);
    return { ok: true, service: config.serviceName, total: items.length, items: items.slice(0, 20) };
  });

  app.post("/comissoes/calcular", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = (request.body || {}) as Record<string, unknown>;
    const idSalao = requireSalao(payload);
    const base = Number(payload.valor_base || payload.valorBase || 0);
    const percentual = Number(payload.percentual || 0);
    const valor = Number(((base * percentual) / 100).toFixed(2));
    const record = appendNdjson(files.comissoes, {
      type: "comissoes:calcular",
      status: "completed",
      id_salao: idSalao,
      valor_base: base,
      percentual,
      valor_comissao: valor,
      payload,
    });
    return { ok: true, service: config.serviceName, calculo: record };
  });

  app.get("/relatorios/vendas", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const query = request.query as { id_salao?: string } | undefined;
    const caixa = readNdjson(files.caixa, 200).filter((item) => !query?.id_salao || item.id_salao === query.id_salao);
    return {
      ok: true,
      service: config.serviceName,
      relatorio: {
        tipo: "vendas",
        totalRegistros: caixa.length,
        geradoEm: new Date().toISOString(),
      },
    };
  });

  app.get("/relatorios/profissionais", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const comissoes = readNdjson(files.comissoes, 200);
    return {
      ok: true,
      service: config.serviceName,
      relatorio: {
        tipo: "profissionais",
        totalCalculos: comissoes.length,
        geradoEm: new Date().toISOString(),
      },
    };
  });

  app.post("/notificacoes/enviar", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const job = createJob("notifications:send", request.body || null, "completed");
    return reply.code(202).send({
      ok: true,
      service: config.serviceName,
      job,
      note: "Envio real ainda deve ser orquestrado pelo sistema principal para evitar duplicidade.",
    });
  });

  app.post("/backup/executar", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const job = createJob("backup:execute", request.body || { mode: "metadata_only" }, "completed");
    return reply.code(202).send({ ok: true, service: config.serviceName, job });
  });
}
