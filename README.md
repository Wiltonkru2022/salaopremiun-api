# SalaoPremiun API

API auxiliar do SalaoPremium para Oracle VPS. Ela nao substitui Vercel nem Supabase; serve para jobs, monitoramento, relatorios, webhooks e calculos que podem rodar fora do frontend principal.

## Stack

- Node.js 20
- Fastify
- TypeScript
- Docker
- Supabase server-side

## Desenvolvimento

```bash
npm install
cp .env.example .env
npm run dev
```

## Build

```bash
npm run build
npm start
```

## Docker

```bash
docker compose up -d --build
```

No Nginx Proxy Manager:

```text
Domain: api.salaopremiun.com.br
Scheme: http
Forward Hostname/IP: salaopremiun-api
Forward Port: 8080
SSL: ativo
Force SSL: ativo
```

## Rotas Publicas

```text
GET /health
GET /ready
GET /version
GET /uptime
GET /status
```

## Rotas Protegidas

Enviar `Authorization: Bearer API_ADMIN_TOKEN` ou `x-salaopremium-api-token`.

```text
GET  /admin/system
POST /jobs/ping
GET  /admin/jobs
POST /jobs/backup/supabase
POST /jobs/notifications/process
POST /jobs/reports/generate
POST /monitoring/event
GET  /admin/monitoring/summary
GET  /admin/monitoring/errors
GET  /admin/monitoring/performance
POST /caixa/fechar
GET  /caixa/resumo
POST /comissoes/calcular
GET  /relatorios/vendas
GET  /relatorios/profissionais
POST /notificacoes/enviar
POST /backup/executar
```

## Webhook Asaas

```text
POST /webhooks/asaas
```

Valida `ASAAS_WEBHOOK_TOKEN` via `asaas-access-token`, `x-asaas-webhook-token` ou `Authorization: Bearer`.

## Seguranca

- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` no frontend.
- Toda rota operacional exige token interno.
- Toda operacao por salao deve validar `id_salao`.
- Webhooks precisam de token e idempotencia.
- Jobs pesados devem ser assíncronos e com limite.
