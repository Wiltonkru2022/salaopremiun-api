import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { requireAdminToken, requireAsaasWebhookToken } from "../lib/auth.js";
import { appendNdjson, files } from "../lib/store.js";

export async function registerWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/internal", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const saved = appendNdjson(files.webhooks, {
      provider: "internal",
      status: "received",
      payload: request.body || null,
      ip: request.ip,
    });
    return reply.code(202).send({ ok: true, service: config.serviceName, received: true, id: saved.id });
  });

  app.get("/admin/webhooks", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    return { ok: true, service: config.serviceName, items: [] };
  });

  app.post("/webhooks/asaas", async (request, reply) => {
    if (!requireAsaasWebhookToken(request, reply)) return;
    const event = appendNdjson(files.webhooks, {
      provider: "asaas",
      status: "received_only",
      note: "Recebido em modo espelho. O caminho oficial so deve mudar apos validacao.",
      payload: request.body || null,
      ip: request.ip,
    });
    return reply.code(202).send({ ok: true, service: config.serviceName, provider: "asaas", received: true, id: event.id });
  });

  app.post("/webhooks/resend", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const event = appendNdjson(files.webhooks, {
      provider: "resend",
      status: "received_only",
      payload: request.body || null,
      ip: request.ip,
    });
    return reply.code(202).send({ ok: true, service: config.serviceName, provider: "resend", received: true, id: event.id });
  });

  app.post("/webhooks/meta", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const event = appendNdjson(files.webhooks, {
      provider: "meta",
      status: "received_only",
      payload: request.body || null,
      ip: request.ip,
    });
    return reply.code(202).send({ ok: true, service: config.serviceName, provider: "meta", received: true, id: event.id });
  });
}
