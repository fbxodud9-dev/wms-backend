// 본 DB(운영) 데이터를 보조 DB로 통째로 복사 (보조 사이트 비상용·테스트 준비용)
//
// 보조 서버(Render 보조 서비스)의 Shell에서만 실행하세요:
//   npm run copy-from-main
//
// 필요한 환경변수 (보조 서비스의 Environment 탭):
//   DATABASE_URL        = 보조 DB 접속 주소 (복사 받는 쪽 - 이 DB의 내용은 전부 지워지고 본 DB 내용으로 바뀜)
//   MAIN_DATABASE_URL   = 본 DB 접속 주소 (읽기만 함, 절대 바뀌지 않음)
//   SITE_ROLE           = backup   ← 이 값이 있는 서버에서만 실행됨 (본 서버에서 실수로 돌려도 본 DB가 안 지워지게)
//   DB_SSL              = true (본 서버와 같게)
//
// 순서: 보조 DB 테이블 비우기 -> 본 DB에서 읽어서 그대로 넣기 -> 번호(id) 순서 맞추기.
// 본 DB에는 SELECT만 하므로 본 DB 데이터는 바뀌지 않는다.
require("dotenv").config();
const { Pool } = require("pg");

const TABLES = ["users", "items", "orders", "order_lines", "transactions", "picking_docs", "daily_volumes", "app_settings"];
const ssl = process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false;

async function main() {
  const target = process.env.DATABASE_URL;
  const source = process.env.MAIN_DATABASE_URL;
  if (process.env.SITE_ROLE !== "backup") throw new Error("SITE_ROLE=backup 인 보조 서버에서만 실행할 수 있어요. (본 서버에서는 실행 금지)");
  if (!target || !source) throw new Error("DATABASE_URL(보조 DB)과 MAIN_DATABASE_URL(본 DB)을 둘 다 넣어주세요.");
  if (target.trim() === source.trim()) throw new Error("DATABASE_URL과 MAIN_DATABASE_URL이 같아요. 보조 DB 주소를 따로 넣어주세요.");

  const src = new Pool({ connectionString: source, ssl });
  const dst = new Pool({ connectionString: target, ssl });
  const client = await dst.connect();
  try {
    // 보조 DB에 테이블이 없으면 먼저 만들기
    const fs = require("fs");
    const path = require("path");
    await client.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

    await client.query("BEGIN");
    await client.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      // 두 DB에 모두 있는 칸만 복사
      const colsOf = async (pool) =>
        (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [t])).rows.map((r) => r.column_name);
      const sCols = await colsOf(src);
      const dCols = new Set(await colsOf(client));
      const cols = sCols.filter((c) => dCols.has(c));
      if (!cols.length) {
        console.log(`- ${t}: 본 DB에 없음, 건너뜀`);
        continue;
      }
      const q = (c) => `"${c.replace(/"/g, '""')}"`;
      const { rows } = await src.query(`SELECT ${cols.map(q).join(", ")} FROM ${t}`);
      const BATCH = 500;
      for (let i = 0; i < rows.length; i += BATCH) {
        const part = rows.slice(i, i + BATCH);
        const vals = [];
        const ph = part.map((r, ri) => `(${cols.map((c, ci) => (vals.push(r[c]), `$${ri * cols.length + ci + 1}`)).join(", ")})`);
        await client.query(`INSERT INTO ${t} (${cols.map(q).join(", ")}) VALUES ${ph.join(", ")}`, vals);
      }
      // 자동 번호(id) 다음 값 맞추기
      if (cols.includes("id")) {
        await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false) WHERE pg_get_serial_sequence('${t}', 'id') IS NOT NULL`);
      }
      console.log(`- ${t}: ${rows.length}줄 복사`);
    }
    await client.query("COMMIT");
    console.log("완료: 본 DB 내용이 보조 DB로 복사됐어요. (본 DB는 그대로)");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await src.end();
    await dst.end();
  }
}

main().catch((err) => {
  console.error("복사 실패:", err.message);
  process.exit(1);
});
