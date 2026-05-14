# SalaoPremiun API

API auxiliar do SalaoPremium para Oracle VPS. Ela não substitui Vercel nem Supabase; serve como braço de processamento para jobs, monitoramento, relatórios, webhooks, notificações e cálculos que podem rodar fora do frontend principal.

Última atualização: 14/05/2026.

## Papel da API

Arquitetura atual:

```txt
Usuário
  ↓
Vercel / Next.js / painel e apps
  ↓
api.salaopremiun.com.br
  ↓
Oracle VPS + Docker + Nginx Proxy Manager
  ↓
Supabase principal
```

O Supabase continua sendo banco, Auth e Storage. A API da VPS processa tarefas auxiliares e devolve dados para o sistema principal.

## Stack

| Camada | Tecnologia |
| --- | --- |
| Runtime | Node.js 20+ |
| API HTTP | Fastify |
| Linguagem | TypeScript |
| Banco externo | Supabase server-side |
| Deploy | Docker Compose na Oracle VPS |
| Proxy | Nginx Proxy Manager |
| Logs locais | Arquivos NDJSON em `DATA_DIR` |

## Repositórios

| Projeto | Repositório |
| --- | --- |
| Sistema principal | `https://github.com/Wiltonkru2022/salaopremiun` |
| API auxiliar | `https://github.com/Wiltonkru2022/salaopremiun-api` |

## O Que Vai Para a VPS

Pode rodar aqui:

- Monitoramento e eventos do sistema.
- Jobs de notificações.
- Reprocessamento de falhas.
- Relatórios pesados.
- Cálculos de caixa e comissões.
- Webhooks externos.
- Backup metadata-only e, no futuro, backup compactado com retenção.
- Limpeza de logs e jobs antigos.

Não colocar aqui por enquanto:

- Frontend completo.
- Supabase Auth substituto.
- Banco principal PostgreSQL.
- Storage principal de imagens.
- Blog público.
- Painel principal completo.

## Variáveis de Ambiente

Use `.env.example` como base. Nunca commite `.env`.

```env
NODE_ENV=production
PORT=8080
HOST=0.0.0.0
SERVICE_NAME=salaopremiun-api
APP_VERSION=0.1.0

API_ADMIN_TOKEN=
API_SECRET=
CRON_SECRET=

DATA_DIR=/data
MAX_NDJSON_LINES=500
RETENTION_DAYS=7

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

ASAAS_API_KEY=
ASAAS_WEBHOOK_TOKEN=

RESEND_API_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY=
```

No projeto principal da Vercel, use:

```env
ORACLE_VPS_API_URL=https://api.salaopremiun.com.br
ORACLE_VPS_API_TOKEN=
```

`ORACLE_VPS_API_TOKEN` precisa ser exatamente o mesmo valor de `API_ADMIN_TOKEN` na VPS.

## Desenvolvimento Local

```bash
npm install
cp .env.example .env
npm run dev
```

Build local:

```bash
npm run build
npm start
```

Smoke test:

```bash
npm run smoke
```

## Deploy na Oracle VPS

Estrutura recomendada na VPS:

```txt
/opt/salaopremium-api
  ├── .env
  ├── docker-compose.yml
  ├── Dockerfile
  ├── package.json
  ├── src/
  └── data/
```

Deploy:

```bash
cd /opt/salaopremium-api
git pull
docker compose up -d --build
docker logs -f salaopremium-api
```

Se preservar uma pasta `data` antiga, ajuste a permissão para o usuário `node` do container:

```bash
sudo chown -R 1000:1000 data
docker restart salaopremium-api
```

## Docker Compose

O container usa a rede externa do Nginx Proxy Manager:

```yaml
services:
  salaopremium-api:
    build: .
    container_name: salaopremium-api
    restart: unless-stopped
    env_file:
      - .env
    environment:
      DATA_DIR: /data
      PORT: 8080
      HOST: 0.0.0.0
    volumes:
      - ./data:/data
    networks:
      - proxy_default

networks:
  proxy_default:
    external: true
```

No Nginx Proxy Manager:

```text
Domain: api.salaopremiun.com.br
Scheme: http
Forward Hostname/IP: salaopremium-api
Forward Port: 8080
SSL: ativo
Force SSL: ativo
```

## Rotas Públicas

Não exigem token:

```text
GET /
GET /health
GET /ready
GET /version
GET /uptime
GET /status
```

Essas rotas são usadas por navegador, Vercel, Admin Master e checks simples.

## Autenticação de Rotas Protegidas

Enviar um dos formatos:

```text
Authorization: Bearer API_ADMIN_TOKEN
x-salaopremium-api-token: API_ADMIN_TOKEN
```

Rotas operacionais, Admin, jobs e monitoramento devem exigir token.

## Rotas de Admin e Jobs

```text
GET  /admin/system
GET  /admin/heartbeat
POST /jobs/ping
GET  /admin/jobs

POST /jobs/backup/supabase
GET  /admin/backups

POST /jobs/notifications/process
GET  /admin/notifications/jobs
POST /admin/notifications/jobs/:id/retry

POST /admin/reprocess/:id/retry
GET  /admin/reprocess

POST /admin/cleanup
POST /jobs/cleanup

POST /jobs/reports/generate
GET  /admin/reports/jobs
```

## Rotas de Monitoramento

```text
POST /monitoring/event
GET  /admin/monitoring/summary
GET  /admin/monitoring/errors
GET  /admin/monitoring/performance
```

Uso esperado:

- erros globais;
- rotas lentas;
- falhas de webhook;
- falhas de cron;
- falhas de notificação;
- alertas da VPS para o Admin Master.

## Webhooks

```text
POST /webhooks/internal
GET  /admin/webhooks
POST /webhooks/asaas
POST /webhooks/resend
POST /webhooks/meta
```

Webhook Asaas:

- valida `ASAAS_WEBHOOK_TOKEN`;
- aceita token via `asaas-access-token`, `x-asaas-webhook-token` ou `Authorization: Bearer`;
- deve ser idempotente para não duplicar cobrança/processamento.

## Operações do Sistema

```text
GET  /caixa
GET  /caixa/resumo
POST /caixa/fechar

GET  /comissoes
POST /comissoes/calcular

GET  /vendas
GET  /vendas/resumo

GET  /relatorio-financeiro
GET  /relatorios/vendas
GET  /relatorios/profissionais

GET  /notificacoes
POST /notificacoes/enviar
POST /notificacoes/processar

POST /backup/executar
GET  /backup
```

Essas rotas devem validar `id_salao`, plano/recurso quando aplicável e nunca expor dados de outro salão.

## App Cliente

```text
GET /app-cliente/disponibilidade
GET /app-cliente/saloes
GET /app-cliente/saloes/:id
GET /app-cliente/saloes/:id/servicos
GET /app-cliente/saloes/:id/profissionais
GET /app-cliente/agendamentos
```

Uso:

- consultas leves e paginadas;
- descoberta de salões;
- disponibilidade de agenda;
- apoio ao app sem sobrecarregar Supabase diretamente.

## App Profissional

```text
GET  /app-profissional/notificacoes
GET  /app-profissional/agenda
GET  /app-profissional/resumo
POST /app-profissional/suporte
POST /app-profissional/suporte/finalizar
POST /app-profissional/tickets
```

Uso:

- agenda do profissional;
- notificações;
- resumo;
- suporte humano;
- tickets.

## Logs e Retenção

Os logs ficam em `DATA_DIR`, normalmente `/data`.

Configurações:

```env
MAX_NDJSON_LINES=500
RETENTION_DAYS=7
```

Regras:

- limitar crescimento dos arquivos;
- limpar logs antigos;
- separar eventos informativos, erros, jobs e webhooks;
- nunca gravar senha, token, chave ou dados sensíveis.

## Backups

Começar com backup metadata-only:

- status;
- data/hora;
- duração;
- contagem de tabelas/itens;
- erro, se houver.

Backup completo de banco deve ser tratado com cuidado:

- compactar;
- limitar retenção;
- não rodar várias vezes por dia;
- não salvar segredo em arquivo público;
- validar espaço em disco antes de executar.

## Segurança

- Nunca expor `SUPABASE_SERVICE_ROLE_KEY` no frontend.
- Toda rota operacional exige token interno.
- Toda operação por salão deve validar `id_salao`.
- Webhooks precisam de token e idempotência.
- Jobs pesados devem ser assíncronos e com limite.
- Não abrir PostgreSQL, Redis ou Docker API na internet.
- Manter público apenas `22`, `80` e `443` sempre que possível.
- Portainer e Nginx Proxy Manager devem ficar atrás de túnel SSH ou bloqueio por IP.
- Fail2ban deve permanecer ativo para SSH.

## Comandos Úteis na VPS

```bash
docker ps
docker logs -f salaopremium-api
docker restart salaopremium-api
docker compose up -d --build
df -h
free -h
docker stats
```

Conexão SSH:

```bash
ssh -i .\ssh-key-2026-05-12.key ubuntu@150.136.75.211
```

## Validação Pós-Deploy

Público:

```bash
curl https://api.salaopremiun.com.br/health
curl https://api.salaopremiun.com.br/ready
curl https://api.salaopremiun.com.br/status
```

Protegido:

```bash
curl -H "Authorization: Bearer $API_ADMIN_TOKEN" https://api.salaopremiun.com.br/admin/system
curl -X POST -H "Authorization: Bearer $API_ADMIN_TOKEN" https://api.salaopremiun.com.br/jobs/ping
```

No sistema principal, validar no Admin Master:

- VPS online/offline;
- memória;
- disco;
- uptime;
- jobs pendentes;
- últimos erros;
- botão de ping.

## Regra Final

A API deve aliviar o SaaS, não criar risco novo. Qualquer rota nova precisa:

1. validar token;
2. validar `id_salao` quando houver dados de salão;
3. não vazar segredo;
4. registrar erro útil;
5. ter limite/paginação;
6. funcionar sem derrubar o sistema principal se a VPS estiver fora do ar.
