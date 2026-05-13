import os from "node:os";
import fs from "node:fs";
import { config } from "../config.js";
import { now } from "./store.js";

export const startedAt = now();

export function diskInfo() {
  try {
    const stat = fs.statfsSync("/");
    const totalBytes = stat.blocks * stat.bsize;
    const freeBytes = stat.bavail * stat.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      totalBytes,
      usedBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? Number(((usedBytes / totalBytes) * 100).toFixed(2)) : null,
    };
  } catch {
    return null;
  }
}

export function systemStatus() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;

  return {
    service: config.serviceName,
    version: config.version,
    startedAt,
    time: now(),
    uptimeSeconds: Math.floor(process.uptime()),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      loadAverage: os.loadavg(),
      memory: {
        totalBytes,
        usedBytes,
        freeBytes,
        usedPercent: Number(((usedBytes / totalBytes) * 100).toFixed(2)),
      },
      disk: diskInfo(),
    },
  };
}
