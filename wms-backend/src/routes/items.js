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
  if (!sku || !name) return res.status(400).json({ error: "상품코드와 품목명은 필수입니다." });
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

// 상품코드(items.sku)를 바꾸면 그 코드를 쓰던 발주 라인/입출고 이력의 코드도 함께 바꿔서 끊기지 않게 한다.
// 결과: "ok" | "same" | "missing"(바꿀 품목 없음) | "conflict"(새 코드를 이미 다른 품목이 사용 중)
async function rekeyItem(client, from, to) {
  if (from === to) return "same";
  const src = await client.query("SELECT 1 FROM items WHERE sku = $1", [from]);
  if (src.rows.length === 0) return "missing";
  const dst = await client.query("SELECT 1 FROM items WHERE sku = $1", [to]);
  if (dst.rows.length > 0) return "conflict";
  await client.query("UPDATE items SET sku = $2, updated_at = now() WHERE sku = $1", [from, to]);
  await client.query("UPDATE order_lines SET sku = $2 WHERE sku = $1", [from, to]);
  await client.query("UPDATE transactions SET sku = $2 WHERE sku = $1", [from, to]);
  return "ok";
}

// POST /items/rekey { pairs: [{ from, to }] } - 발주파일의 상품코드로 상품마스터 코드를 일괄 교체
router.post("/rekey", async (req, res) => {
  const pairs = Array.isArray(req.body && req.body.pairs) ? req.body.pairs : [];
  const clean = pairs
    .map((p) => ({ from: String((p && p.from) || "").trim(), to: String((p && p.to) || "").trim() }))
    .filter((p) => p.from && p.to);
  if (clean.length === 0) return res.status(400).json({ error: "바꿀 상품코드 목록(pairs)이 필요합니다." });
  if (clean.length > 1000) return res.status(400).json({ error: "한 번에 1000건까지만 바꿀 수 있습니다." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const results = [];
    for (const p of clean) {
      results.push({ from: p.from, to: p.to, status: await rekeyItem(client, p.from, p.to) });
    }
    await client.query("COMMIT");
    res.json({ renamed: results.filter((r) => r.status === "ok").length, results });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "상품코드 교체 중 오류가 발생했습니다." });
  } finally {
    client.release();
  }
});

// PATCH /items/:sku - 품목마스터 정보 수정 (온도구역/작업유형/로케이션/단위 등)
router.patch("/:sku", async (req, res) => {
  let { sku } = req.params;
  const fields = req.body || {};
  // 상품코드 자체를 바꾸는 경우 (body.newSku)
  const newSku = fields.newSku !== undefined ? String(fields.newSku).trim() : "";
  if (newSku && newSku !== sku) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await rekeyItem(client, sku, newSku);
      if (r === "missing") {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "해당 상품코드를 찾을 수 없습니다." });
      }
      if (r === "conflict") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "이미 다른 품목이 사용 중인 상품코드입니다." });
      }
      await client.query("COMMIT");
      sku = newSku;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(e);
      return res.status(500).json({ error: "상품코드 변경 중 오류가 발생했습니다." });
    } finally {
      client.release();
    }
  }
  const allowed = ["name", "category", "location", "unit", "qty", "safety", "temp_zone", "work_type", "unit_qty", "box_qty", "cbm"];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) {
    if (newSku) {
      const cur = await pool.query("SELECT * FROM items WHERE sku = $1", [sku]);
      return res.json({ item: cur.rows[0] });
    }
    return res.status(400).json({ error: "수정할 값이 없습니다." });
  }
  values.push(sku);
  try {
    const { rows } = await pool.query(`UPDATE items SET ${sets.join(", ")}, updated_at = now() WHERE sku = $${i} RETURNING *`, values);
    if (rows.length === 0) return res.status(404).json({ error: "해당 상품코드를 찾을 수 없습니다." });
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
    if (rows.length === 0) throw new Error("해당 상품코드를 찾을 수 없습니다. 먼저 품목을 등록해주세요.");
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
    if (cur.rows.length === 0) throw new Error("해당 상품코드를 찾을 수 없습니다.");
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

// DELETE /items/:sku - 품목 삭제 (시범/테스트 품목 정리용)
router.delete("/:sku", async (req, res) => {
  const { sku } = req.params;
  try {
    const { rows } = await pool.query("DELETE FROM items WHERE sku = $1 RETURNING sku", [sku]);
    if (rows.length === 0) return res.status(404).json({ error: "해당 상품코드를 찾을 수 없습니다." });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "품목 삭제 중 오류가 발생했습니다." });
  }
});

module.exports = router;
