import type { FastifyInstance, FastifyRequest } from "fastify";
import fs from "node:fs";
import { config } from "../config.js";
import { requireAdminToken } from "../lib/auth.js";
import { compactAllNdjsonFiles, countBy, createJob, files, readNdjson } from "../lib/store.js";
import { systemStatus } from "../lib/system.js";
import { getSecuritySupabaseAdmin } from "../lib/supabase.js";
import { extendTrial, processTrialAlerts, sendTrialAlertNow } from "../lib/trialAlerts.js";

function limitFromQuery(request: FastifyRequest, fallback = 20, max = 100) {
  const query = request.query as { limit?: string } | undefined;
  return Math.min(Number(query?.limit || fallback), max);
}

function retentionDaysFromBody(body: unknown, fallback = 90) {
  const value =
    body && typeof body === "object"
      ? Number((body as { securityRetentionDays?: unknown }).securityRetentionDays)
      : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(7, Math.min(value, 365));
}

async function cleanupSecurityEvents(body: unknown) {
  const securitySupabase = getSecuritySupabaseAdmin();
  if (!securitySupabase) {
    return {
      provider: "security-supabase",
      configured: false,
      deleted: null,
      retentionDays: retentionDaysFromBody(body),
    };
  }

  const retentionDays = retentionDaysFromBody(body);
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const table = config.securityEventsTable || "security_events";
  const { count, error } = await securitySupabase
    .from(table)
    .delete({ count: "exact" })
    .lt("criado_em", cutoff);

  if (error) {
    return {
      provider: "security-supabase",
      configured: true,
      ok: false,
      table,
      error: error.message,
      retentionDays,
      cutoff,
    };
  }

  return {
    provider: "security-supabase",
    configured: true,
    ok: true,
    table,
    deleted: count || 0,
    retentionDays,
    cutoff,
  };
}

export async function registerAdminRoutes(app: FastifyInstance) {
  app.get("/admin/system", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    return { ok: true, ...systemStatus() };
  });

  app.get("/admin/heartbeat", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    let heartbeat = null;
    try {
      heartbeat = JSON.parse(fs.readFileSync(files.heartbeat, "utf8"));
    } catch {}
    return { ok: true, service: config.serviceName, heartbeat };
  });

  app.post("/jobs/ping", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const job = createJob("ping", request.body || null, "completed");
    return reply.code(202).send({ ok: true, service: config.serviceName, job });
  });

  app.get("/admin/jobs", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    return {
      ok: true,
      service: config.serviceName,
      items: readNdjson(files.jobs, limitFromQuery(request)),
    };
  });

  app.post("/jobs/backup/supabase", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = (request.body || {}) as { mode?: string };
    const mode = payload.mode || "metadata_only";
    const backup = createJob("backup:supabase", { mode, system: systemStatus() }, "completed");
    return reply.code(202).send({
      ok: true,
      service: config.serviceName,
      backup: {
        ...backup,
        type: "supabase",
        mode,
        note: "Backup metadata-only registrado sem carga pesada no Supabase.",
      },
    });
  });

  app.get("/admin/backups", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const jobs = readNdjson(files.jobs, limitFromQuery(request)).filter((item) => item.type === "backup:supabase");
    return { ok: true, service: config.serviceName, items: jobs };
  });

  app.post("/jobs/notifications/process", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const job = createJob("notifications:process", request.body || null, "completed");
    return reply.code(202).send({
      ok: true,
      service: config.serviceName,
      job: {
        ...job,
        note: "Varredura leve registrada. Envio real continua protegido contra duplicidade.",
      },
    });
  });

  app.get("/admin/notifications/jobs", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const jobs = readNdjson(files.jobs, limitFromQuery(request)).filter((item) =>
      String(item.type).startsWith("notifications:"),
    );
    return { ok: true, service: config.serviceName, items: jobs };
  });

  app.post("/jobs/trial-alerts/process", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const result = await processTrialAlerts((request.body || {}) as Record<string, unknown>);
    return reply.code(202).send(result);
  });

  app.post("/trial-alerts/send-now", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const result = await sendTrialAlertNow((request.body || {}) as Record<string, unknown>);
    return reply.code(202).send(result);
  });

  app.post("/trial-alerts/extend", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const result = await extendTrial((request.body || {}) as Record<string, unknown>);
    return reply.code(202).send(result);
  });

  app.get("/admin/trial-alerts/jobs", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const jobs = readNdjson(files.jobs, limitFromQuery(request)).filter((item) =>
      String(item.type || "").startsWith("trial-alerts:"),
    );
    return { ok: true, service: config.serviceName, items: jobs };
  });

  app.post("/admin/notifications/jobs/:id/retry", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const params = request.params as { id: string };
    const job = createJob("notifications:retry", { retryOf: params.id }, "completed");
    return reply.code(202).send({ ok: true, service: config.serviceName, retry: job });
  });

  app.post("/admin/reprocess/:id/retry", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const params = request.params as { id: string };
    const reprocessItems = readNdjson(files.reprocess, config.maxNdjsonLines);
    const original = reprocessItems.find((item) => item.id === params.id || item.jobId === params.id);
    const job = createJob("reprocess:retry", { retryOf: params.id, original: original || null }, "queued");
    return reply.code(202).send({ ok: true, service: config.serviceName, retry: job });
  });

  app.post("/admin/cleanup", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const result = compactAllNdjsonFiles();
    const securityResult = await cleanupSecurityEvents(request.body);
    const job = createJob(
      "cleanup:manual",
      { result, securityResult, requested: request.body || null },
      "completed"
    );
    return reply.code(202).send({
      ok: true,
      service: config.serviceName,
      job,
      result,
      securityResult,
    });
  });

  app.post("/admin/security/cleanup", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const securityResult = await cleanupSecurityEvents(request.body);
    const job = createJob(
      "cleanup:security-events",
      { securityResult, requested: request.body || null },
      "completed"
    );
    return reply
      .code(202)
      .send({ ok: true, service: config.serviceName, job, securityResult });
  });

  app.post("/jobs/reports/generate", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const events = readNdjson(files.monitoring, config.maxNdjsonLines);
    const jobs = readNdjson(files.jobs, config.maxNdjsonLines);
    const report = createJob(
      "reports:generate",
      {
        input: request.body || null,
        summary: {
          totalEvents: events.length,
          totalJobs: jobs.length,
          pendingJobs: jobs.filter((item) => item.status === "queued").length,
          bySeverity: countBy(events, (item) => String(item.severity || "info")),
          byJobType: countBy(jobs, (item) => String(item.type || "indefinido")),
        },
      },
      "completed",
    );
    return reply.code(202).send({ ok: true, service: config.serviceName, report });
  });

  app.get("/admin/reports/jobs", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const jobs = readNdjson(files.jobs, limitFromQuery(request)).filter((item) => item.type === "reports:generate");
    return { ok: true, service: config.serviceName, items: jobs };
  });
}
