import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { requireAdminToken, requireAsaasWebhookToken } from "../lib/auth.js";
import { processAsaasWebhookOfficial } from "../lib/asaas.js";
import { appendNdjson, createReprocessJob, files, readNdjson } from "../lib/store.js";

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
    return { ok: true, service: config.serviceName, items: readNdjson(files.webhooks, 100) };
  });

  app.post("/webhooks/asaas", async (request, reply) => {
    if (!requireAsaasWebhookToken(request, reply)) return;
    const payload = (request.body || {}) as Record<string, unknown>;
    const saved = appendNdjson(files.webhooks, {
      provider: "asaas",
      status: "processing",
      payload,
      ip: request.ip,
    });

    try {
      const result = await processAsaasWebhookOfficial(payload);
      appendNdjson(files.webhooks, {
        provider: "asaas",
        status: "processed",
        sourceEventId: saved.id,
        result,
      });
      return reply.code(200).send({ ok: true, service: config.serviceName, provider: "asaas", id: saved.id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Falha ao processar webhook Asaas.";
      const retry = createReprocessJob("asaas:webhook", payload, message);
      appendNdjson(files.webhooks, {
        provider: "asaas",
        status: "failed",
        sourceEventId: saved.id,
        error: message,
        retryJobId: retry.id,
      });
      return reply.code(202).send({
        ok: false,
        service: config.serviceName,
        provider: "asaas",
        queuedForRetry: true,
        retryJobId: retry.id,
        error: message,
      });
    }
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
