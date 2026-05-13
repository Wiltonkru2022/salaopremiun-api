import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { config } from "../config.js";
import { files, now } from "../lib/store.js";
import { startedAt, systemStatus } from "../lib/system.js";

export async function registerPublicRoutes(app: FastifyInstance) {
  app.get("/", async () => ({
    ok: true,
    service: config.serviceName,
    status: "online",
    version: config.version,
    time: now(),
  }));

  app.get("/health", async () => ({
    ok: true,
    service: config.serviceName,
    status: "online",
    version: config.version,
    startedAt,
    time: now(),
  }));

  app.get("/ready", async () => ({
    ok: true,
    service: config.serviceName,
    ready: true,
    checks: {
      http: "ok",
      storage: fs.existsSync(config.dataDir) ? "ok" : "falhou",
      tokenConfigured: config.apiAdminToken ? "ok" : "falhou",
    },
    time: now(),
  }));

  app.get("/version", async () => ({
    ok: true,
    service: config.serviceName,
    version: config.version,
    node: process.version,
  }));

  app.get("/uptime", async () => ({
    ok: true,
    service: config.serviceName,
    startedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    time: now(),
  }));

  app.get("/status", async () => {
    const status = systemStatus();
    return {
      ok: true,
      service: config.serviceName,
      status: "online",
      version: config.version,
      uptimeSeconds: status.uptimeSeconds,
      memoryUsedPercent: status.host.memory.usedPercent,
      diskUsedPercent: status.host.disk?.usedPercent ?? null,
      loadAverage: status.host.loadAverage,
      time: status.time,
    };
  });

  app.addHook("onReady", async () => {
    fs.writeFileSync(
      files.heartbeat,
      JSON.stringify({ ok: true, service: config.serviceName, reason: "boot", time: now() }, null, 2),
    );
  });
}
