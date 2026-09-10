const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GET /items - 전체 품목 조회
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM items ORDER BY sku");
    res.json({ items: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "품목 조회 중 오류가 발생했습니다." });
  }
});

// POST /items - 신규 품목 등록 (입고 시 신규 품목이면 함께 생성)
router.post("/", async (req, res) => {
  const { sku, name, category, location, unit, qty, safety, temp_zone, work_type, unit_qty, box_qty, cbm } = req.body || {};
  if (!sku || !name) return res.status(400).json({ error: "SKU와 품목명은 필수입니다." });
  try {
    const { rows } = await pool.query(
      `INSERT INTO items (sku, name, category, location, unit, qty, safety, temp_zone, work_type, unit_qty, box_qty, cbm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING *`,
      [sku, name, category || null, location || null, unit || "EA", qty || 0, safety || 0, temp_zone || "상온", work_type || "피킹", unit_qty || 1, box_qty || 1, cbm || 0]
    );
    res.status(201).json({ item: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "품목 등록 중 오류가 발생했습니다." });
  }
});

// PATCH /items/:sku - 품목마스터 정보 수정 (온도구역/작업유형/로케이션/단위 등)
router.patch("/:sku", async (req, res) => {
  const { sku } = req.params;
  const fields = req.body || {};
  const allowed = ["name", "category", "location", "unit", "safety", "temp_zone", "work_type", "unit_qty", "box_qty", "cbm"];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "수정할 값이 없습니다." });
  values.push(sku);
  try {
    const { rows } = await pool.query(`UPDATE items SET ${sets.join(", ")}, updated_at = now() WHERE sku = $${i} RETURNING *`, values);
    if (rows.length === 0) return res.status(404).json({ error: "해당 SKU를 찾을 수 없습니다." });
    res.json({ item: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "품목 수정 중 오류가 발생했습니다." });
  }
});

// POST /items/:sku/inbound { qty, memo, date, location }
router.post("/:sku/inbound", async (req, res) => {
  const { sku } = req.params;
  const { qty, memo, date, location } = req.body || {};
  if (!qty || qty <= 0) return res.status(400).json({ error: "입고 수량은 1 이상이어야 합니다." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE items SET qty = qty + $1, location = COALESCE($2, location), updated_at = now() WHERE sku = $3 RETURNING *`,
      [qty, location || null, sku]
    );
    if (rows.length === 0) throw new Error("해당 SKU를 찾을 수 없습니다. 먼저 품목을 등록해주세요.");
    await client.query(
      `INSERT INTO transactions (type, sku, name, qty, location, tx_date, memo) VALUES ('IN', $1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6)`,
      [sku, rows[0].name, qty, rows[0].location, date || null, memo || null]
    );
    await client.query("COMMIT");
    res.json({ item: rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /items/:sku/outbound { qty, memo, date }
router.post("/:sku/outbound", async (req, res) => {
  const { sku } = req.params;
  const { qty, memo, date } = req.body || {};
  if (!qty || qty <= 0) return res.status(400).json({ error: "출고 수량은 1 이상이어야 합니다." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query("SELECT * FROM items WHERE sku = $1 FOR UPDATE", [sku]);
    if (cur.rows.length === 0) throw new Error("해당 SKU를 찾을 수 없습니다.");
    if (cur.rows[0].qty < qty) throw new Error(`현재 재고(${cur.rows[0].qty})보다 많은 수량은 출고할 수 없습니다.`);
    const { rows } = await client.query(`UPDATE items SET qty = qty - $1, updated_at = now() WHERE sku = $2 RETURNING *`, [qty, sku]);
    await client.query(
      `INSERT INTO transactions (type, sku, name, qty, location, tx_date, memo) VALUES ('OUT', $1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6)`,
      [sku, rows[0].name, qty, rows[0].location, date || null, memo || null]
    );
    await client.query("COMMIT");
    res.json({ item: rows[0] });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
