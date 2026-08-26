import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const forbidden = [/@supabase\//, /SUPABASE_URL/, /SUPABASE_ANON_KEY/, /SUPABASE_SERVICE_ROLE_KEY/, /\.supabase\.co/];
const allowedCompatibility = new Set(["src/lib/supabase.ts"]);
const violations = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(?:ts|js|mjs|cjs)$/.test(entry.name)) continue;
    const rel = path.relative(root, full).replaceAll("\\", "/");
    const text = fs.readFileSync(full, "utf8");
    if (allowedCompatibility.has(rel)) continue;
    for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${rel}: ${pattern}`);
  }
}

walk(path.join(root, "src"));
if (violations.length) {
  console.error("Referencias runtime do Supabase encontradas:\n" + violations.join("\n"));
  process.exit(1);
}
console.log("OK: API runtime sem Supabase; dados via Neon Data API.");
