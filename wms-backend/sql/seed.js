require("dotenv").config();
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

const SEED_ITEMS = [
  { sku: "ELEC-1001", name: "무선 이어폰", category: "가전", location: "A-01-01", unit: "개", qty: 120, safety: 50, temp_zone: "상온", work_type: "피킹", unit_qty: 1, box_qty: 20, cbm: 0.02 },
  { sku: "FOOD-4002", name: "생수 2L 6팩", category: "식품", location: "D-01-02", unit: "팩", qty: 25, safety: 40, temp_zone: "냉장", work_type: "피킹", unit_qty: 1, box_qty: 6, cbm: 0.07 },
  { sku: "PACK-5001", name: "골판지 박스(중)", category: "포장자재", location: "E-01-01", unit: "개", qty: 300, safety: 100, temp_zone: "상온", work_type: "낱개출고", unit_qty: 1, box_qty: 1, cbm: 0.09 },
];

async function main() {
  // 초기 직원 계정 (비밀번호는 반드시 로그인 후 변경하세요)
  const hash1 = await bcrypt.hash("wms1234", 10);
  const hash2 = await bcrypt.hash("wms1234", 10);

  await pool.query(
    `INSERT INTO users (username, password_hash, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING`,
    ["staff1", hash1, "직원1"]
  );
  await pool.query(
    `INSERT INTO users (username, password_hash, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING`,
    ["staff2", hash2, "직원2"]
  );

  for (const it of SEED_ITEMS) {
    await pool.query(
      `INSERT INTO items (sku, name, category, location, unit, qty, safety, temp_zone, work_type, unit_qty, box_qty, cbm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (sku) DO NOTHING`,
      [it.sku, it.name, it.category, it.location, it.unit, it.qty, it.safety, it.temp_zone, it.work_type, it.unit_qty, it.box_qty, it.cbm]
    );
  }

  console.log("시드 완료.");
  console.log("초기 계정 -> staff1 / wms1234, staff2 / wms1234");
  console.log("반드시 로그인 후 비밀번호를 변경하세요. (직원이 늘어나면 이 스크립트에 계정을 추가해 다시 실행하면 됩니다.)");
  await pool.end();
}

main().catch((err) => {
  console.error("시드 실패:", err.message);
  process.exit(1);
});
