import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { requireAdminToken } from "../lib/auth.js";
import { appendNdjson, countBy, files, readNdjson } from "../lib/store.js";
import { getSecuritySupabaseAdmin } from "../lib/supabase.js";

function limitFromQuery(request: FastifyRequest, fallback = 20, max = 100) {
  const query = request.query as { limit?: string } | undefined;
  return Math.min(Number(query?.limit || fallback), max);
}

function stringValue(value: unknown) {
  const text = String(value || "").trim();
  return text || null;
}

function extractSecurityIp(payload: Record<string, unknown>, request: FastifyRequest) {
  const details =
    payload.details && typeof payload.details === "object"
      ? (payload.details as Record<string, unknown>)
      : {};

  return (
    stringValue(payload.ip) ||
    stringValue(details.ip) ||
    stringValue(request.headers["x-real-ip"]) ||
    stringValue(String(request.headers["x-forwarded-for"] || "").split(",")[0]) ||
    stringValue(request.ip)
  );
}

export async function registerMonitoringRoutes(app: FastifyInstance) {
  app.post("/monitoring/event", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const payload = (request.body || {}) as Record<string, unknown>;
    const event = appendNdjson(files.monitoring, {
      severity: payload.severity || "info",
      type: payload.type || "event",
      route: payload.route || null,
      source: payload.source || "salaopremium",
      durationMs: payload.durationMs ?? null,
      message: payload.message || null,
      payload,
      ip: request.ip,
    });
    return reply.code(202).send({ ok: true, service: config.serviceName, eventId: event.id });
  });

  app.post("/monitoring/security-event", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;

    const payload = (request.body || {}) as Record<string, unknown>;
    const realIp = extractSecurityIp(payload, request);
    const event = appendNdjson(files.security, {
      severity: payload.severity || "info",
      type: payload.type || "security_event",
      module: payload.module || "security",
      eventType: payload.eventType || "security_event",
      route: payload.route || null,
      source: payload.source || "salaopremium-next",
      idSalao: payload.idSalao || null,
      idUsuario: payload.idUsuario || null,
      details: payload.details || {},
      message: payload.message || null,
      ip: realIp,
      connectionIp: request.ip,
    });

    const securitySupabase = getSecuritySupabaseAdmin();
    if (securitySupabase) {
      const table = config.securityEventsTable || "security_events";
      const { error } = await securitySupabase.from(table).insert({
        id: event.id,
        user_id: payload.userId || null,
        id_salao: payload.idSalao || null,
        tipo_usuario: payload.tipoUsuario || "salao",
        evento: String(payload.eventType || payload.type || "security_event"),
        risco: String(payload.severity || "info"),
        detalhes: payload.details || {},
        ip: realIp,
        user_agent: request.headers["user-agent"] || null,
        criado_em: event.createdAt,
      });

      if (error) {
        request.log.warn(
          { err: error, table },
          "Failed to persist security event on Supabase"
        );
      }
    }

    return reply
      .code(202)
      .send({ ok: true, service: config.serviceName, eventId: event.id });
  });

  app.get("/admin/monitoring/summary", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const events = readNdjson(files.monitoring, config.maxNdjsonLines);
    const errors = events.filter((item) => ["error", "critical", "alta"].includes(String(item.severity).toLowerCase()));
    const durations = events.map((item) => Number(item.durationMs)).filter(Number.isFinite);
    const averageDurationMs = durations.length
      ? Number((durations.reduce((total, item) => total + item, 0) / durations.length).toFixed(2))
      : null;

    return {
      ok: true,
      service: config.serviceName,
      totalEvents: events.length,
      errors: errors.length,
      bySeverity: countBy(events, (item) => String(item.severity || "info")),
      byType: countBy(events, (item) => String(item.type || "event")),
      averageDurationMs,
      lastEventAt: events[0]?.createdAt || null,
    };
  });

  app.get("/admin/monitoring/errors", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const events = readNdjson(files.monitoring, config.maxNdjsonLines)
      .filter((item) => ["error", "critical", "alta"].includes(String(item.severity || "").toLowerCase()))
      .slice(0, limitFromQuery(request));
    return { ok: true, service: config.serviceName, items: events };
  });

  app.get("/admin/monitoring/performance", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;
    const events = readNdjson(files.monitoring, config.maxNdjsonLines);
    const measured = events.filter((item) => Number.isFinite(Number(item.durationMs)));
    return {
      ok: true,
      service: config.serviceName,
      totalMeasured: measured.length,
      slowEvents: measured.filter((item) => Number(item.durationMs) >= 1000).slice(0, 30),
    };
  });

  app.get("/admin/security/events", async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;

    const query = (request.query || {}) as {
      limit?: string;
      risco?: string;
      evento?: string;
      tipo_usuario?: string;
    };
    const limit = limitFromQuery(request, 50, 200);
    const securitySupabase = getSecuritySupabaseAdmin();

    if (securitySupabase) {
      const table = config.securityEventsTable || "security_events";
      let select = securitySupabase
        .from(table)
        .select(
          "id, user_id, id_salao, tipo_usuario, evento, risco, ip, user_agent, detalhes, criado_em"
        )
        .order("criado_em", { ascending: false })
        .limit(limit);

      if (query.risco) select = select.eq("risco", query.risco);
      if (query.evento) select = select.eq("evento", query.evento);
      if (query.tipo_usuario) select = select.eq("tipo_usuario", query.tipo_usuario);

      const { data, error } = await select;

      if (error) {
        request.log.warn({ err: error, table }, "Failed to read security events");
        return reply.code(502).send({
          ok: false,
          service: config.serviceName,
          error: "Falha ao carregar eventos de seguranca.",
          message: error.message,
        });
      }

      const items = data || [];
      return {
        ok: true,
        service: config.serviceName,
        provider: "security-supabase",
        total: items.length,
        byRisk: countBy(items, (item) => String(item.risco || "info")),
        byEvent: countBy(items, (item) => String(item.evento || "security_event")),
        items,
      };
    }

    const items = readNdjson(files.security, limit);
    return {
      ok: true,
      service: config.serviceName,
      provider: "ndjson",
      total: items.length,
      byRisk: countBy(items, (item) => String(item.severity || "info")),
      byEvent: countBy(items, (item) => String(item.eventType || "security_event")),
      items,
    };
  });
}
