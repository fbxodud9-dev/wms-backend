const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// 화면 설정값(예: 피킹지시서 공급사/상품 순서)을 키 하나당 JSON 한 덩어리로 저장한다.
// 별도 마이그레이션 없이 첫 요청 때 테이블을 스스로 만든다.
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS app_settings (
           setting_key TEXT PRIMARY KEY,
           value JSONB NOT NULL DEFAULT '{}'::jsonb,
           updated_by TEXT,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      )
      .catch((e) => {
        tableReady = null;
        throw e;
      });
  }
  return tableReady;
}

const KEY_RE = /^[a-z0-9_]{1,40}$/;

// GET /settings/sync/version - 화면 실시간 동기화용 "변경 표시" (가벼운 숫자만).
// 다른 직원이 설정을 저장하거나 발주를 올리면/지우면/수정하면 값이 바뀌고, 화면은 바뀐 것만 다시 불러온다.
router.get("/sync/version", async (req, res) => {
  try {
    await ensureTable();
    const s = await pool.query("SELECT setting_key, updated_at FROM app_settings");
    const settings = {};
    s.rows.forEach((r) => (settings[r.setting_key] = new Date(r.updated_at).getTime()));
    const one = async (sql) => {
      try {
        const r = await pool.query(sql);
        return r.rows.map((x) => Object.values(x).map((v) => (v instanceof Date ? v.getTime() : String(v))).join(":")).join("|");
      } catch (e) {
        return "x";
      }
    };
    const parts = await Promise.all([
      one("SELECT COUNT(*) AS c, MAX(created_at) AS m FROM orders"),
      one("SELECT status, COUNT(*) AS c FROM orders GROUP BY status ORDER BY status"),
      one("SELECT COUNT(*) AS c, SUM(COALESCE(changed_qty, qty)) AS q FROM order_lines"),
      one("SELECT picked, COUNT(*) AS c FROM order_lines GROUP BY picked ORDER BY picked"),
      one("SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM items"),
    ]);
    res.json({ settings, data: parts.join("#") });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "동기화 정보를 불러오지 못했습니다." });
  }
});

// GET /settings/:key - 저장된 값 (한 번도 저장한 적 없으면 value: null)
router.get("/:key", async (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "설정 이름이 올바르지 않습니다." });
  try {
    await ensureTable();
    const { rows } = await pool.query("SELECT value, updated_at FROM app_settings WHERE setting_key = $1", [key]);
    if (rows.length === 0) return res.json({ value: null });
    res.json({ value: rows[0].value, updatedAt: rows[0].updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "설정을 불러오는 중 오류가 발생했습니다." });
  }
});

// PUT /settings/:key { value: {...} } - 통째로 교체 저장
router.put("/:key", async (req, res) => {
  const { key } = req.params;
  if (!KEY_RE.test(key)) return res.status(400).json({ error: "설정 이름이 올바르지 않습니다." });
  const value = req.body && req.body.value;
  if (value === undefined || value === null || typeof value !== "object") {
    return res.status(400).json({ error: "value 객체가 필요합니다." });
  }
  const json = JSON.stringify(value);
  if (json.length > 200000) return res.status(400).json({ error: "설정 내용이 너무 큽니다." });
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `INSERT INTO app_settings (setting_key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (setting_key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING value, updated_at`,
      [key, json, (req.user && (req.user.name || req.user.username)) || null]
    );
    res.json({ value: rows[0].value, updatedAt: rows[0].updated_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "설정 저장 중 오류가 발생했습니다." });
  }
});

module.exports = router;
