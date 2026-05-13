import { spawn } from "node:child_process";

const port = 18080;
const env = {
  ...process.env,
  NODE_ENV: "test",
  PORT: String(port),
  HOST: "127.0.0.1",
  API_ADMIN_TOKEN: "test-token",
  ASAAS_WEBHOOK_TOKEN: "asaas-token",
  DATA_DIR: "./data-smoke",
};

const server = spawn(process.execPath, ["dist/server.js"], { env, stdio: "inherit" });

async function waitForReady() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("API nao ficou pronta para smoke test.");
}

try {
  await waitForReady();

  const headers = {
    authorization: "Bearer test-token",
    "content-type": "application/json",
  };

  const checks = [
    fetch(`http://127.0.0.1:${port}/status`),
    fetch(`http://127.0.0.1:${port}/admin/system`, { headers }),
    fetch(`http://127.0.0.1:${port}/jobs/ping`, { method: "POST", headers, body: "{}" }),
    fetch(`http://127.0.0.1:${port}/comissoes/calcular`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id_salao: "demo", valor_base: 100, percentual: 40 }),
    }),
    fetch(`http://127.0.0.1:${port}/webhooks/asaas`, {
      method: "POST",
      headers: { "asaas-access-token": "asaas-token", "content-type": "application/json" },
      body: JSON.stringify({ event: "PAYMENT_CONFIRMED" }),
    }),
  ];

  const responses = await Promise.all(checks);
  const failed = responses.filter((response) => !response.ok);
  if (failed.length) {
    throw new Error(`Smoke test falhou em ${failed.length} rota(s).`);
  }

  console.log("Smoke test OK");
} finally {
  server.kill("SIGTERM");
}
