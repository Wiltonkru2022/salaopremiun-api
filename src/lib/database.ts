import { config } from "../config.js";

type QueryResult<T = unknown> = { data: T | null; error: { message: string; code?: string } | null; count?: number | null };
type Filter = { column: string; op: string; value: unknown };
type Order = { column: string; ascending?: boolean; nullsFirst?: boolean };
type Mutation =
  | { kind: "insert"; payload: unknown }
  | { kind: "update"; payload: unknown }
  | { kind: "delete" }
  | { kind: "upsert"; payload: unknown; options?: { onConflict?: string; ignoreDuplicates?: boolean } };
type ClientConfig = { baseUrl: string; token?: string };

function encodeFilterValue(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `(${value.map((item) => String(item)).join(",")})`;
  return String(value);
}

function createBuilder(clientConfig: ClientConfig, table: string) {
  const filters: Filter[] = [];
  const orders: Order[] = [];
  let selected = "*";
  let mutation: Mutation | null = null;
  let limitValue: number | undefined;
  let rangeValue: [number, number] | undefined;
  let singleMode: "single" | "maybeSingle" | null = null;
  let countMode: string | undefined;
  let headMode = false;

  const builder: any = {
    select(columns = "*", options?: { count?: string; head?: boolean }) { selected = columns; countMode = options?.count; headMode = options?.head === true; return builder; },
    insert(payload: unknown) { mutation = { kind: "insert", payload }; return builder; },
    update(payload: unknown) { mutation = { kind: "update", payload }; return builder; },
    delete() { mutation = { kind: "delete" }; return builder; },
    upsert(payload: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }) { mutation = { kind: "upsert", payload, options }; return builder; },
    eq(column: string, value: unknown) { filters.push({ column, op: "eq", value }); return builder; },
    neq(column: string, value: unknown) { filters.push({ column, op: "neq", value }); return builder; },
    gt(column: string, value: unknown) { filters.push({ column, op: "gt", value }); return builder; },
    gte(column: string, value: unknown) { filters.push({ column, op: "gte", value }); return builder; },
    lt(column: string, value: unknown) { filters.push({ column, op: "lt", value }); return builder; },
    lte(column: string, value: unknown) { filters.push({ column, op: "lte", value }); return builder; },
    like(column: string, value: unknown) { filters.push({ column, op: "like", value }); return builder; },
    ilike(column: string, value: unknown) { filters.push({ column, op: "ilike", value }); return builder; },
    is(column: string, value: unknown) { filters.push({ column, op: "is", value }); return builder; },
    in(column: string, value: unknown[]) { filters.push({ column, op: "in", value }); return builder; },
    contains(column: string, value: unknown) { filters.push({ column, op: "cs", value }); return builder; },
    match(values: Record<string, unknown>) { Object.entries(values || {}).forEach(([column, value]) => filters.push({ column, op: "eq", value })); return builder; },
    order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) { orders.push({ column, ascending: options?.ascending, nullsFirst: options?.nullsFirst }); return builder; },
    limit(value: number) { limitValue = value; return builder; },
    range(from: number, to: number) { rangeValue = [from, to]; return builder; },
    single() { singleMode = "single"; return builder; },
    maybeSingle() { singleMode = "maybeSingle"; return builder; },
    async then(resolve: (value: QueryResult<any>) => unknown, reject?: (reason: unknown) => unknown) {
      try {
        const params = new URLSearchParams();
        params.set("select", selected);
        for (const filter of filters) params.append(filter.column, `${filter.op}.${encodeFilterValue(filter.value)}`);
        if (orders.length) params.set("order", orders.map((item) => `${item.column}.${item.ascending === false ? "desc" : "asc"}${item.nullsFirst === true ? ".nullsfirst" : item.nullsFirst === false ? ".nullslast" : ""}`).join(","));
        if (limitValue !== undefined) params.set("limit", String(limitValue));
        if (rangeValue) { params.set("offset", String(rangeValue[0])); params.set("limit", String(Math.max(rangeValue[1] - rangeValue[0] + 1, 0))); }

        const requestHeaders: Record<string, string> = { Accept: "application/json" };
        if (clientConfig.token) requestHeaders.Authorization = `Bearer ${clientConfig.token}`;
        if (countMode) requestHeaders.Prefer = `count=${countMode}`;
        let method = "GET";
        let body: string | undefined;
        if (mutation?.kind === "insert") { method = "POST"; body = JSON.stringify(mutation.payload); requestHeaders["Content-Type"] = "application/json"; requestHeaders.Prefer = [requestHeaders.Prefer, "return=representation"].filter(Boolean).join(","); }
        else if (mutation?.kind === "upsert") { method = "POST"; body = JSON.stringify(mutation.payload); requestHeaders["Content-Type"] = "application/json"; requestHeaders.Prefer = [requestHeaders.Prefer, mutation.options?.ignoreDuplicates ? "resolution=ignore-duplicates" : "resolution=merge-duplicates", "return=representation"].filter(Boolean).join(","); if (mutation.options?.onConflict) params.set("on_conflict", mutation.options.onConflict); }
        else if (mutation?.kind === "update") { method = "PATCH"; body = JSON.stringify(mutation.payload); requestHeaders["Content-Type"] = "application/json"; requestHeaders.Prefer = [requestHeaders.Prefer, "return=representation"].filter(Boolean).join(","); }
        else if (mutation?.kind === "delete") { method = "DELETE"; requestHeaders.Prefer = [requestHeaders.Prefer, "return=representation"].filter(Boolean).join(","); }

        const response = await fetch(`${clientConfig.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(table)}?${params.toString()}`, { method: headMode ? "HEAD" : method, headers: requestHeaders, body });
        const raw = headMode ? "" : await response.text();
        const parsed = raw ? JSON.parse(raw) : null;
        if (!response.ok) return resolve({ data: null, error: { message: parsed?.message || parsed?.error || `Neon Data API HTTP ${response.status}`, code: parsed?.code }, count: null });
        const contentRange = response.headers.get("content-range");
        const count = contentRange?.includes("/") ? Number(contentRange.split("/").pop()) : null;
        let data: any = parsed;
        if (singleMode) {
          const rows = Array.isArray(parsed) ? parsed : parsed == null ? [] : [parsed];
          if (singleMode === "single" && rows.length !== 1) return resolve({ data: null, error: { message: `Esperado 1 registro; recebidos ${rows.length}.` }, count });
          if (singleMode === "maybeSingle" && rows.length > 1) return resolve({ data: null, error: { message: `Esperado no maximo 1 registro; recebidos ${rows.length}.` }, count });
          data = rows[0] ?? null;
        }
        return resolve({ data, error: null, count });
      } catch (error) {
        if (reject) return reject(error);
        return resolve({ data: null, error: { message: error instanceof Error ? error.message : "Falha na Neon Data API." }, count: null });
      }
    },
  };
  return builder;
}

export function createNeonDataApiClient(baseUrl: string, token?: string) {
  const clientConfig = { baseUrl: baseUrl.trim(), token: token?.trim() || undefined };
  return {
    from(table: string) { return createBuilder(clientConfig, table); },
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      try {
        const requestHeaders: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
        if (clientConfig.token) requestHeaders.Authorization = `Bearer ${clientConfig.token}`;
        const response = await fetch(`${clientConfig.baseUrl.replace(/\/$/, "")}/rpc/${encodeURIComponent(fn)}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(args) });
        const raw = await response.text();
        const data = raw ? JSON.parse(raw) : null;
        return response.ok ? { data, error: null } : { data: null, error: { message: data?.message || `Neon Data API HTTP ${response.status}`, code: data?.code } };
      } catch (error) { return { data: null, error: { message: error instanceof Error ? error.message : "Falha no RPC Neon." } }; }
    },
    channel() { const channel: any = { on() { return channel; }, subscribe(callback?: (status: string) => void) { callback?.("SUBSCRIBED"); return channel; } }; return channel; },
    async removeChannel() { return "ok"; },
  };
}

export function getDatabaseAdmin() {
  if (!config.neonDataApiUrl) return null;
  return createNeonDataApiClient(config.neonDataApiUrl, config.neonDataApiToken);
}

export function getSecurityDatabaseAdmin() {
  const url = config.securityNeonDataApiUrl || config.neonDataApiUrl;
  const token = config.securityNeonDataApiToken || config.neonDataApiToken;
  if (!url) return null;
  return createNeonDataApiClient(url, token);
}
