import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { randomId } from "./crypto.js";

export type StoredEntry = Record<string, unknown> & {
  id: string;
  createdAt: string;
};

fs.mkdirSync(config.dataDir, { recursive: true });

export const files = {
  heartbeat: path.join(config.dataDir, "heartbeat.json"),
  jobs: path.join(config.dataDir, "jobs.ndjson"),
  backups: path.join(config.dataDir, "backups.ndjson"),
  notifications: path.join(config.dataDir, "notifications.ndjson"),
  reports: path.join(config.dataDir, "reports.ndjson"),
  monitoring: path.join(config.dataDir, "monitoring.ndjson"),
  security: path.join(config.dataDir, "security.ndjson"),
  webhooks: path.join(config.dataDir, "webhooks.ndjson"),
  caixa: path.join(config.dataDir, "caixa.ndjson"),
  comissoes: path.join(config.dataDir, "comissoes.ndjson"),
  vendas: path.join(config.dataDir, "vendas.ndjson"),
  reprocess: path.join(config.dataDir, "reprocess.ndjson"),
  cleanup: path.join(config.dataDir, "cleanup.ndjson"),
};

export function now() {
  return new Date().toISOString();
}

function trimFile(file: string) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
    const lines = raw
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        try {
          const item = JSON.parse(line) as { createdAt?: string };
          const createdAt = item.createdAt ? Date.parse(item.createdAt) : Date.now();
          return Number.isFinite(createdAt) && createdAt >= cutoff;
        } catch {
          return false;
        }
      })
      .slice(-config.maxNdjsonLines);

    fs.writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
  } catch {
    // File may not exist yet.
  }
}

export function appendNdjson(file: string, entry: Record<string, unknown>): StoredEntry {
  const saved = {
    id: randomId(),
    createdAt: now(),
    ...entry,
  };

  fs.appendFileSync(file, `${JSON.stringify(saved)}\n`);
  trimFile(file);
  return saved;
}

export function readNdjson<T extends StoredEntry = StoredEntry>(file: string, limit = 20): T[] {
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line) as T)
      .reverse();
  } catch {
    return [];
  }
}

export function compactNdjsonFile(file: string, options?: { maxLines?: number; retentionDays?: number }) {
  const maxLines = options?.maxLines || config.maxNdjsonLines;
  const retentionDays = options?.retentionDays || config.retentionDays;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  try {
    const lines = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        try {
          const item = JSON.parse(line) as { createdAt?: string };
          const createdAt = item.createdAt ? Date.parse(item.createdAt) : Date.now();
          return Number.isFinite(createdAt) && createdAt >= cutoff;
        } catch {
          return false;
        }
      })
      .slice(-maxLines);

    fs.writeFileSync(file, lines.length ? `${lines.join("\n")}\n` : "");
    return { file, before: undefined, after: lines.length };
  } catch {
    return { file, before: undefined, after: 0 };
  }
}

export function compactAllNdjsonFiles() {
  return Object.entries(files)
    .filter(([name]) => name !== "heartbeat")
    .map(([name, file]) => ({ name, ...compactNdjsonFile(file) }));
}

export function findNdjsonById<T extends StoredEntry = StoredEntry>(file: string, id: string): T | null {
  return readNdjson<T>(file, config.maxNdjsonLines).find((item) => item.id === id) || null;
}

export function createJob(type: string, payload: unknown, status: "queued" | "completed" | "failed" = "queued") {
  return appendNdjson(files.jobs, {
    type,
    status,
    payload: payload || null,
    processedAt: status === "completed" ? now() : null,
  });
}

export function createReprocessJob(type: string, payload: unknown, reason: string) {
  const job = createJob(`reprocess:${type}`, { reason, payload }, "queued");
  appendNdjson(files.reprocess, {
    type,
    status: "queued",
    reason,
    payload: payload || null,
    jobId: job.id,
  });
  return job;
}

export function countBy<T>(items: T[], keyFn: (item: T) => string | null | undefined) {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFn(item) || "indefinido";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}


