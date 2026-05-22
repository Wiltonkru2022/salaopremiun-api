import type { FastifyReply, FastifyRequest } from "fastify";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export type ProfessionalTokenType = "access" | "refresh";

export type ProfessionalJwtPayload = {
  sub: string;
  idProfissional: string;
  idSalao: string;
  nome: string;
  tipo: "profissional";
  tokenType: ProfessionalTokenType;
  iat: number;
  exp: number;
  jti: string;
};

export type ProfessionalAuthContext = {
  idProfissional: string;
  idSalao: string;
  nome: string;
  tokenId: string;
};

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function secretFor(type: ProfessionalTokenType) {
  const secret =
    type === "refresh" ? config.professionalRefreshSecret : config.professionalJwtSecret;
  if (!secret) {
    const error = new Error("Segredo JWT do app profissional não configurado.");
    (error as Error & { statusCode?: number }).statusCode = 503;
    throw error;
  }
  return secret;
}

function sign(input: string, secret: string) {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createProfessionalToken(params: {
  idProfissional: string;
  idSalao: string;
  nome: string;
  tokenType: ProfessionalTokenType;
  expiresInSeconds: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload: ProfessionalJwtPayload = {
    sub: params.idProfissional,
    idProfissional: params.idProfissional,
    idSalao: params.idSalao,
    nome: params.nome,
    tipo: "profissional",
    tokenType: params.tokenType,
    iat: now,
    exp: now + params.expiresInSeconds,
    jti: randomUUID(),
  };
  const header = { alg: "HS256", typ: "JWT" };
  const input = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  return `${input}.${sign(input, secretFor(params.tokenType))}`;
}

export function verifyProfessionalToken(token: string, expectedType: ProfessionalTokenType) {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return null;
  const input = `${header}.${payload}`;
  const expected = sign(input, secretFor(expectedType));
  if (!safeEqual(signature, expected)) return null;

  let decoded: ProfessionalJwtPayload;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ProfessionalJwtPayload;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (decoded.tipo !== "profissional") return null;
  if (decoded.tokenType !== expectedType) return null;
  if (!decoded.idProfissional || !decoded.idSalao) return null;
  if (Number(decoded.exp || 0) <= now) return null;
  return decoded;
}

export function bearerTokenFromRequest(request: FastifyRequest) {
  const auth = String(request.headers.authorization || "");
  if (!auth.toLowerCase().startsWith("bearer ")) return "";
  return auth.slice(7).trim();
}

export function requireProfessionalAuth(request: FastifyRequest, reply: FastifyReply) {
  const payload = verifyProfessionalToken(bearerTokenFromRequest(request), "access");
  if (!payload) {
    reply.code(401).send({
      ok: false,
      service: config.serviceName,
      error: "Sessão expirada. Entre novamente para continuar.",
    });
    return null;
  }

  return {
    idProfissional: payload.idProfissional,
    idSalao: payload.idSalao,
    nome: payload.nome,
    tokenId: payload.jti,
  } satisfies ProfessionalAuthContext;
}
