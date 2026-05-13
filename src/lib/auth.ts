import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { safeEqual } from "./crypto.js";

export function tokenFromRequest(request: FastifyRequest) {
  const auth = String(request.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(request.headers["x-salaopremium-api-token"] || "").trim();
}

export function requireAdminToken(request: FastifyRequest, reply: FastifyReply) {
  if (safeEqual(tokenFromRequest(request), config.apiAdminToken)) return true;

  reply.code(401).send({
    ok: false,
    service: config.serviceName,
    error: "Acesso nao autorizado.",
  });
  return false;
}

export function webhookTokenFromRequest(request: FastifyRequest) {
  const auth = String(request.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(
    request.headers["asaas-access-token"] ||
      request.headers["x-asaas-webhook-token"] ||
      request.headers["x-webhook-token"] ||
      "",
  ).trim();
}

export function requireAsaasWebhookToken(request: FastifyRequest, reply: FastifyReply) {
  if (safeEqual(webhookTokenFromRequest(request), config.asaasWebhookToken)) return true;

  reply.code(401).send({
    ok: false,
    service: config.serviceName,
    error: "Webhook nao autorizado.",
  });
  return false;
}
