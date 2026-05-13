import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerMonitoringRoutes } from "./routes/monitoring.js";
import { registerOperationRoutes } from "./routes/operations.js";
import { registerPublicRoutes } from "./routes/public.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";

export function buildServer() {
  const app = Fastify({
    logger: config.nodeEnv !== "test",
    bodyLimit: 512 * 1024,
  });

  app.setErrorHandler((error, _request, reply) => {
    const knownError = error as Error & { statusCode?: number };
    const statusCode = knownError.statusCode || 500;
    reply.code(statusCode).send({
      ok: false,
      service: config.serviceName,
      error: statusCode === 500 ? "Erro interno da API." : knownError.message,
      message: knownError.message,
    });
  });

  app.register(registerPublicRoutes);
  app.register(registerAdminRoutes);
  app.register(registerMonitoringRoutes);
  app.register(registerWebhookRoutes);
  app.register(registerOperationRoutes);

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = buildServer();
  await app.listen({ port: config.port, host: config.host });
}
