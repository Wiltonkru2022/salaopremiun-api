import { Pool, neonConfig } from "@neondatabase/serverless";
import WebSocket from "ws";
import { config } from "../config.js";

neonConfig.webSocketConstructor = WebSocket as any;

type Filter = { op: string; column: string; value?: unknown; operator?: string };
type Order = { column: string; ascending: boolean; nullsFirst?: boolean };
type Mutation =
  | { kind: "insert"; payload: unknown }
  | { kind: "update"; payload: unknown }
  | { kind: "delete" }
  | { kind: "upsert"; payload: unknown; options?: { onConflict?: string; ignoreDuplicates?: boolean } };

type State = {
  table: string;
  select: string;
  selectOptions?: { count?: string; head?: boolean };
  filters: Filter[];
  orders: Order[];
  limit?: number;
  range?: [number, number];
  single?: boolean;
  maybeSingle?: boolean;
  mutation?: Mutation;
};

type QueryResult = {
  data: any;
  error: { message: string; code?: string } | null;
  count: number | null;
  status: number;
  statusText: string;
};

const pools = new Map<string, Pool>();

function getPool(url: string) {
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url });
    pools.set(url, pool);
  }
  return pool;
}

function ident(value: string) {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalized)) {
    throw new Error(`Identificador SQL inválido: ${normalized}`);
  }
  return `"${normalized}"`;
}

function splitTopLevel(value: string) {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function relationForeignKey(baseTable: string, relation: string) {
  const singular: Record<string, string> = {
    clientes: "cliente_id",
    servicos: "servico_id",
    profissionais: "profissional_id",
    saloes: "id_salao",
    comandas: "id_comanda",
    produtos: "produto_id",
    usuarios: "usuario_id",
    planos: "plano_id",
  };
  if (singular[relation]) return { baseColumn: singular[relation], relationColumn: "id" };
  const baseSingular = baseTable.replace(/s$/, "");
  return { baseColumn: "id", relationColumn: `${baseSingular}_id` };
}

function parseSelect(baseTable: string, select: string) {
  const raw = String(select || "*").trim();
  if (!raw || raw === "*") return { expressions: [`b.*`], joins: [] as string[] };

  const expressions: string[] = [];
  const joins: string[] = [];
  let relationIndex = 0;

  for (const tokenRaw of splitTopLevel(raw)) {
    const token = tokenRaw.trim();
    const relationMatch = token.match(/^([a-zA-Z_][\w]*)(?::([a-zA-Z_][\w]*))?(?:![\w-]+)?\((.*)\)$/s);
    if (relationMatch) {
      const outputName = relationMatch[1];
      const relation = relationMatch[2] || relationMatch[1];
      const fields = splitTopLevel(relationMatch[3]).filter((field) => /^[a-zA-Z_][\w]*$/.test(field));
      const alias = `r${relationIndex++}`;
      const fk = relationForeignKey(baseTable, relation);
      joins.push(
        `LEFT JOIN ${ident(relation)} ${alias} ON ${alias}.${ident(fk.relationColumn)} = b.${ident(fk.baseColumn)}`
      );
      const object = fields.length
        ? `jsonb_build_object(${fields.map((field) => `'${field.replace(/'/g, "''")}', ${alias}.${ident(field)}`).join(", ")})`
        : `to_jsonb(${alias})`;
      expressions.push(`CASE WHEN ${alias}.id IS NULL THEN NULL ELSE ${object} END AS ${ident(outputName)}`);
      continue;
    }

    if (token === "*") {
      expressions.push("b.*");
      continue;
    }

    const aliasMatch = token.match(/^([a-zA-Z_][\w]*):([a-zA-Z_][\w]*)$/);
    if (aliasMatch) {
      expressions.push(`b.${ident(aliasMatch[2])} AS ${ident(aliasMatch[1])}`);
      continue;
    }

    if (/^[a-zA-Z_][\w]*$/.test(token)) {
      expressions.push(`b.${ident(token)}`);
      continue;
    }

    throw new Error(`Select não suportado no adaptador Neon: ${token}`);
  }

  return { expressions: expressions.length ? expressions : ["b.*"], joins };
}

function pushValue(values: unknown[], value: unknown) {
  values.push(value);
  return `$${values.length}`;
}

function whereSql(filters: Filter[], values: unknown[]) {
  const clauses: string[] = [];
  for (const filter of filters) {
    const column = `b.${ident(filter.column)}`;
    switch (filter.op) {
      case "eq": clauses.push(`${column} = ${pushValue(values, filter.value)}`); break;
      case "neq": clauses.push(`${column} <> ${pushValue(values, filter.value)}`); break;
      case "gt": clauses.push(`${column} > ${pushValue(values, filter.value)}`); break;
      case "gte": clauses.push(`${column} >= ${pushValue(values, filter.value)}`); break;
      case "lt": clauses.push(`${column} < ${pushValue(values, filter.value)}`); break;
      case "lte": clauses.push(`${column} <= ${pushValue(values, filter.value)}`); break;
      case "like": clauses.push(`${column} LIKE ${pushValue(values, filter.value)}`); break;
      case "ilike": clauses.push(`${column} ILIKE ${pushValue(values, filter.value)}`); break;
      case "is":
        clauses.push(filter.value === null ? `${column} IS NULL` : filter.value === true ? `${column} IS TRUE` : filter.value === false ? `${column} IS FALSE` : `${column} IS NOT DISTINCT FROM ${pushValue(values, filter.value)}`);
        break;
      case "in": {
        const list = Array.isArray(filter.value) ? filter.value : [];
        if (!list.length) clauses.push("FALSE");
        else clauses.push(`${column} IN (${list.map((item) => pushValue(values, item)).join(",")})`);
        break;
      }
      case "contains": clauses.push(`${column} @> ${pushValue(values, JSON.stringify(filter.value))}::jsonb`); break;
      case "not": {
        const operator = String(filter.operator || "eq").toLowerCase();
        if (operator === "in") {
          const raw = String(filter.value || "").replace(/^\(|\)$/g, "");
          const list = raw.split(",").map((v) => v.trim()).filter(Boolean);
          clauses.push(list.length ? `${column} NOT IN (${list.map((item) => pushValue(values, item)).join(",")})` : "TRUE");
        } else if (operator === "is") {
          clauses.push(filter.value === null ? `${column} IS NOT NULL` : `${column} IS DISTINCT FROM ${pushValue(values, filter.value)}`);
        } else {
          clauses.push(`${column} <> ${pushValue(values, filter.value)}`);
        }
        break;
      }
      default: throw new Error(`Filtro Neon não suportado: ${filter.op}`);
    }
  }
  return clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function normalizePayload(payload: unknown) {
  return Array.isArray(payload) ? payload : [payload];
}

async function execute(url: string, state: State): Promise<QueryResult> {
  const client = await getPool(url).connect();
  try {
    const values: unknown[] = [];
    const table = ident(state.table);
    const selection = parseSelect(state.table, state.select);
    const where = whereSql(state.filters, values);
    const order = state.orders.length
      ? ` ORDER BY ${state.orders.map((item) => `b.${ident(item.column)} ${item.ascending ? "ASC" : "DESC"}${item.nullsFirst === undefined ? "" : item.nullsFirst ? " NULLS FIRST" : " NULLS LAST"}`).join(", ")}`
      : "";
    const offset = state.range ? Math.max(0, state.range[0]) : 0;
    const calculatedLimit = state.range ? Math.max(0, state.range[1] - state.range[0] + 1) : state.limit;
    const limit = calculatedLimit !== undefined ? ` LIMIT ${Math.max(0, Number(calculatedLimit))}` : "";
    const offsetSql = offset ? ` OFFSET ${offset}` : "";
    let rows: any[] = [];
    let count: number | null = null;

    if (!state.mutation) {
      if (state.selectOptions?.count) {
        const countResult = await client.query(`SELECT count(*)::int AS count FROM ${table} b${where}`, values);
        count = Number(countResult.rows[0]?.count || 0);
        if (state.selectOptions.head) return { data: null, error: null, count, status: 200, statusText: "OK" };
      }
      const sql = `SELECT ${selection.expressions.join(", ")} FROM ${table} b ${selection.joins.join(" ")}${where}${order}${limit}${offsetSql}`;
      const result = await client.query(sql, values);
      rows = result.rows;
    } else if (state.mutation.kind === "insert" || state.mutation.kind === "upsert") {
      const records = normalizePayload(state.mutation.payload).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
      if (!records.length) throw new Error("Payload de insert vazio.");
      const columns = Array.from(new Set(records.flatMap((record) => Object.keys(record))));
      const tuples = records.map((record) => `(${columns.map((column) => pushValue(values, record[column] ?? null)).join(",")})`);
      let conflict = "";
      if (state.mutation.kind === "upsert") {
        const conflictColumns = String(state.mutation.options?.onConflict || "id").split(",").map((v) => v.trim()).filter(Boolean);
        if (state.mutation.options?.ignoreDuplicates) conflict = ` ON CONFLICT (${conflictColumns.map(ident).join(",")}) DO NOTHING`;
        else {
          const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
          conflict = ` ON CONFLICT (${conflictColumns.map(ident).join(",")}) DO UPDATE SET ${updateColumns.map((column) => `${ident(column)} = EXCLUDED.${ident(column)}`).join(", ") || `${ident(conflictColumns[0])} = EXCLUDED.${ident(conflictColumns[0])}`}`;
        }
      }
      const result = await client.query(`INSERT INTO ${table} (${columns.map(ident).join(",")}) VALUES ${tuples.join(",")}${conflict} RETURNING *`, values);
      rows = result.rows;
    } else if (state.mutation.kind === "update") {
      const payload = state.mutation.payload as Record<string, unknown>;
      const entries = Object.entries(payload || {});
      if (!entries.length) throw new Error("Payload de update vazio.");
      const set = entries.map(([column, value]) => `${ident(column)} = ${pushValue(values, value)}`).join(", ");
      const updateWhere = whereSql(state.filters, values);
      const result = await client.query(`UPDATE ${table} b SET ${set}${updateWhere} RETURNING b.*`, values);
      rows = result.rows;
    } else if (state.mutation.kind === "delete") {
      const deleteWhere = whereSql(state.filters, values);
      const result = await client.query(`DELETE FROM ${table} b${deleteWhere} RETURNING b.*`, values);
      rows = result.rows;
    }

    const data = state.single || state.maybeSingle ? rows[0] ?? null : rows;
    if (state.single && rows.length !== 1) {
      return { data: null, error: { message: `Esperado 1 registro, encontrados ${rows.length}.` }, count, status: 406, statusText: "Not Acceptable" };
    }
    return { data, error: null, count, status: 200, statusText: "OK" };
  } catch (cause: any) {
    return {
      data: null,
      error: { message: cause instanceof Error ? cause.message : "Falha no Neon.", code: cause?.code },
      count: null,
      status: 500,
      statusText: "Error",
    };
  } finally {
    client.release();
  }
}

function createClient(url: string) {
  return {
    from(table: string) {
      const state: State = { table, select: "*", filters: [], orders: [] };
      let throwOnError = false;
      const builder: any = {
        select(columns = "*", options?: { count?: string; head?: boolean }) { state.select = columns; state.selectOptions = options; return builder; },
        insert(payload: unknown) { state.mutation = { kind: "insert", payload }; return builder; },
        update(payload: unknown) { state.mutation = { kind: "update", payload }; return builder; },
        delete() { state.mutation = { kind: "delete" }; return builder; },
        upsert(payload: unknown, options?: { onConflict?: string; ignoreDuplicates?: boolean }) { state.mutation = { kind: "upsert", payload, options }; return builder; },
        eq(column: string, value: unknown) { state.filters.push({ op: "eq", column, value }); return builder; },
        neq(column: string, value: unknown) { state.filters.push({ op: "neq", column, value }); return builder; },
        gt(column: string, value: unknown) { state.filters.push({ op: "gt", column, value }); return builder; },
        gte(column: string, value: unknown) { state.filters.push({ op: "gte", column, value }); return builder; },
        lt(column: string, value: unknown) { state.filters.push({ op: "lt", column, value }); return builder; },
        lte(column: string, value: unknown) { state.filters.push({ op: "lte", column, value }); return builder; },
        like(column: string, value: unknown) { state.filters.push({ op: "like", column, value }); return builder; },
        ilike(column: string, value: unknown) { state.filters.push({ op: "ilike", column, value }); return builder; },
        is(column: string, value: unknown) { state.filters.push({ op: "is", column, value }); return builder; },
        in(column: string, value: unknown[]) { state.filters.push({ op: "in", column, value }); return builder; },
        contains(column: string, value: unknown) { state.filters.push({ op: "contains", column, value }); return builder; },
        not(column: string, operator: string, value: unknown) { state.filters.push({ op: "not", column, operator, value }); return builder; },
        order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) { state.orders.push({ column, ascending: options?.ascending !== false, nullsFirst: options?.nullsFirst }); return builder; },
        limit(value: number) { state.limit = value; return builder; },
        range(from: number, to: number) { state.range = [from, to]; return builder; },
        single() { state.single = true; return builder; },
        maybeSingle() { state.maybeSingle = true; return builder; },
        throwOnError() { throwOnError = true; return builder; },
        async then(resolve: (value: QueryResult) => unknown, reject?: (reason: unknown) => unknown) {
          try {
            const result = await execute(url, state);
            if (throwOnError && result.error) throw new Error(result.error.message);
            return resolve(result);
          } catch (cause) {
            if (reject) return reject(cause);
            throw cause;
          }
        },
      };
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      const values = Object.values(args);
      const placeholders = values.map((_, index) => `$${index + 1}`).join(",");
      const client = await getPool(url).connect();
      try {
        const result = await client.query(`SELECT * FROM ${ident(fn)}(${placeholders})`, values);
        return { data: result.rows, error: null, count: null, status: 200, statusText: "OK" };
      } catch (cause: any) {
        return { data: null, error: { message: cause instanceof Error ? cause.message : "Falha na RPC Neon.", code: cause?.code }, count: null, status: 500, statusText: "Error" };
      } finally {
        client.release();
      }
    },
  };
}

/** Nome preservado para compatibilidade; retorna exclusivamente Neon. */
export function getSupabaseAdmin() {
  return config.neonDatabaseUrl ? createClient(config.neonDatabaseUrl) : null;
}

/** Banco de segurança também migrou para Neon. */
export function getSecuritySupabaseAdmin() {
  return config.securityNeonDatabaseUrl ? createClient(config.securityNeonDatabaseUrl) : null;
}
