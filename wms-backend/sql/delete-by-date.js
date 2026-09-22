// 특정 날짜의 발주만 삭제합니다 (다른 날짜 데이터는 그대로 유지됨).
// 사용법: node sql/delete-by-date.js 2026-09-23
require("dotenv").config();
const { Pool, types } = require("pg");
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

async function main() {
  const dateArg = process.argv[2];
  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error("사용법: node sql/delete-by-date.js YYYY-MM-DD  (예: node sql/delete-by-date.js 2026-09-23)");
    process.exit(1);
  }

  const check = await pool.query("SELECT COUNT(*) FROM orders WHERE order_date = $1", [dateArg]);
  const count = Number(check.rows[0].count);
  console.log(`${dateArg} 날짜의 발주 ${count}건을 삭제합니다 (품목 라인·피킹지시서도 함께 삭제됩니다).`);

  if (count === 0) {
    console.log("삭제할 발주가 없습니다.");
    await pool.end();
    return;
  }

  const res = await pool.query("DELETE FROM orders WHERE order_date = $1", [dateArg]);
  console.log(`완료: ${res.rowCount}건 삭제되었습니다.`);
  await pool.end();
}

main().catch((err) => {
  console.error("삭제 실패:", err.message);
  process.exit(1);
});
