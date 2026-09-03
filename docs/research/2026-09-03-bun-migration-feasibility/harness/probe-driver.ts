import { createPool } from "../../../../server/db.ts";
import { createDatabase } from "../../../../app/lib/db.server.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const url = process.env.DATABASE_URL!;
const pool = createPool(url);
let bad = 0;
const check = (name: string, ok: boolean, got: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> ${typeof got} ${JSON.stringify(got)}`);
  if (!ok) bad++;
};

// 1. Type parsers: numeric / int8 / date must arrive as strings.
const r = await pool.query(
  "select 12345.6789::numeric as n, 9223372036854775807::int8 as big, '2026-01-31'::date as d, now()::timestamptz as ts",
);
const row = r.rows[0];
check("numeric -> string", typeof row.n === "string" && row.n === "12345.6789", row.n);
check("int8 -> string", typeof row.big === "string" && row.big === "9223372036854775807", row.big);
check("date -> string 'YYYY-MM-DD'", typeof row.d === "string" && row.d === "2026-01-31", row.d);
check("timestamptz stays Date", row.ts instanceof Date, String(row.ts));

// 2. numeric scale preserved as stored (money assertions depend on it)
const s = await pool.query("select 250.0000::numeric(19,4) as m");
check("numeric(19,4) keeps trailing zeros", s.rows[0].m === "250.0000", s.rows[0].m);

// 3. bytea round-trip via Buffer
await pool.query("create temp table b (x bytea)");
await pool.query("insert into b values ($1)", [Buffer.from("héllo,csv\n", "utf8")]);
const b = await pool.query("select x from b");
const got = b.rows[0].x;
check("bytea -> Buffer instance", Buffer.isBuffer(got), got?.constructor?.name);
check("bytea round-trip content", Buffer.from(got).toString("utf8") === "héllo,csv\n", Buffer.from(got).toString("utf8"));
check("Buffer.prototype.equals", Buffer.from(got).equals(Buffer.from("héllo,csv\n", "utf8")), true);

// 4. Advisory lock on a checked-out client + release(true)
const c1 = await pool.connect();
const locked = await c1.query("select pg_try_advisory_lock(7295380114023642) as locked");
check("pg_try_advisory_lock", locked.rows[0].locked === true, locked.rows[0].locked);
c1.release(true); // destroy rather than reuse
check("release(true) did not throw", true, "ok");

// 5. pool error/acquire/release event wiring (server/db.ts relies on these)
let acquires = 0, releases = 0;
pool.on("acquire", () => { acquires++; });
pool.on("release", () => { releases++; });
const c2 = await pool.connect();
await c2.query("select 1");
c2.release();
check("pool 'acquire' fired", acquires === 1, acquires);
check("pool 'release' fired", releases === 1, releases);

// 6. Kysely over the same pool, reading a real view from the migrations
const db = createDatabase(url);
const rows = await db.selectFrom("schema_migrations").select(["filename"]).execute();
check("kysely query returns migration rows", rows.length === 11, rows.length);

// 7. AsyncLocalStorage (the test-isolation seam) survives an await boundary
const als = new AsyncLocalStorage<string>();
const inner = await als.run("marker", async () => {
  await pool.query("select pg_sleep(0)");
  return als.getStore();
});
check("AsyncLocalStorage across await", inner === "marker", inner);

// 8. node:crypto sha256 (column-mapping fingerprint)
check("sha256 hex", createHash("sha256").update("a,b,c", "utf8").digest("hex").length === 64, createHash("sha256").update("a,b,c","utf8").digest("hex").slice(0,16));

await db.destroy();
await pool.end();
console.log(bad === 0 ? "\nALL PASS" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
