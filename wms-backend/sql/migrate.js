require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("스키마 적용 중...");
  await pool.query(sql);
  console.log("완료되었습니다. 테이블이 생성/갱신되었습니다.");
  await pool.end();
}

main().catch((err) => {
  console.error("마이그레이션 실패:", err.message);
  process.exit(1);
});
