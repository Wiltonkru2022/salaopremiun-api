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
  webhooks: path.join(config.dataDir, "webhooks.ndjson"),
  caixa: path.join(config.dataDir, "caixa.ndjson"),
  comissoes: path.join(config.dataDir, "comissoes.ndjson"),
  vendas: path.join(config.dataDir, "vendas.ndjson"),
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

export function countBy<T>(items: T[], keyFn: (item: T) => string | null | undefined) {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFn(item) || "indefinido";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}


