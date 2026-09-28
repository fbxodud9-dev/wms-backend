const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// 일자별 물동량(대시보드용). 채널별 수기 입력값을 날짜 하나당 JSON 한 덩어리로 저장한다.
// 별도 마이그레이션 없이 첫 요청 때 테이블을 스스로 만든다.
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS daily_volumes (
           vol_date DATE PRIMARY KEY,
           data JSONB NOT NULL DEFAULT '{}'::jsonb,
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /volumes?from=YYYY-MM-DD&to=YYYY-MM-DD - 기간 내 저장된 일자별 물동량
router.get("/", async (req, res) => {
  const { from, to } = req.query;
  if (!DATE_RE.test(from || "") || !DATE_RE.test(to || "")) {
    return res.status(400).json({ error: "from, to 날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)." });
  }
  try {
    await ensureTable();
    const { rows } = await pool.query(
      "SELECT vol_date, data, updated_at FROM daily_volumes WHERE vol_date BETWEEN $1 AND $2 ORDER BY vol_date",
      [from, to]
    );
    res.json({ volumes: rows.map((r) => ({ date: r.vol_date, data: r.data, updatedAt: r.updated_at })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "물동량 조회 중 오류가 발생했습니다." });
  }
});

// PUT /volumes/:date - 그 날짜 물동량 저장(통째로 교체). body: { data: { emart_1: 18441, ... } }, 빈 값(null)은 제거
router.put("/:date", async (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)." });
  const input = (req.body && req.body.data) || null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return res.status(400).json({ error: "data 객체가 필요합니다." });
  }
  const clean = {};
  for (const [k, v] of Object.entries(input)) {
    if (!/^[a-z0-9_]{1,40}$/.test(k)) return res.status(400).json({ error: `항목 이름이 올바르지 않습니다: ${k}` });
    if (v === null || v === "" || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `${k} 값은 0 이상의 숫자여야 합니다.` });
    clean[k] = Math.round(n);
  }
  if (Object.keys(clean).length > 60) return res.status(400).json({ error: "항목이 너무 많습니다." });
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `INSERT INTO daily_volumes (vol_date, data, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (vol_date) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING vol_date, data, updated_at`,
      [date, JSON.stringify(clean), (req.user && (req.user.name || req.user.username)) || null]
    );
    const r = rows[0];
    res.json({ volume: { date: r.vol_date, data: r.data, updatedAt: r.updated_at } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "물동량 저장 중 오류가 발생했습니다." });
  }
});

module.exports = router;
