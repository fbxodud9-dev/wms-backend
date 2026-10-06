const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GS 일별 발주 집계(상품별 총수량) 스냅샷. 날짜 하나당 JSON 한 덩어리.
// 발주 원본은 14일 뒤 자동 삭제되지만, 월별 집계를 위해 이 스냅샷은 지우지 않는다.
// 별도 마이그레이션 없이 첫 요청 때 테이블을 스스로 만든다.
let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS gs_daily_totals (
           day DATE PRIMARY KEY,
           data JSONB NOT NULL DEFAULT '{}'::jsonb,
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
// DATE 컬럼은 db.js에서 문자열로 받지만, 혹시 Date 객체로 와도 YYYY-MM-DD로 맞춘다
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const MONTH_RE = /^\d{4}-\d{2}$/;

// GET /gs-daily?month=YYYY-MM  - 그 달 저장된 날짜별 스냅샷
// GET /gs-daily/months         - 저장된 달 목록
router.get("/months", async (req, res) => {
  try {
    await ensureTable();
    const { rows } = await pool.query("SELECT day FROM gs_daily_totals");
    const months = Array.from(new Set(rows.map((r) => ymd(r.day).slice(0, 7)))).sort().reverse();
    res.json({ months });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "월 목록 조회 중 오류가 발생했습니다." });
  }
});

router.get("/", async (req, res) => {
  const { month } = req.query;
  if (!MONTH_RE.test(month || "")) return res.status(400).json({ error: "month 형식이 올바르지 않습니다 (YYYY-MM)." });
  try {
    await ensureTable();
    const [y, m] = month.split("-").map(Number);
    const from = `${month}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const to = `${month}-${String(last).padStart(2, "0")}`;
    const { rows } = await pool.query("SELECT day, data, updated_at FROM gs_daily_totals WHERE day BETWEEN $1 AND $2 ORDER BY day", [from, to]);
    res.json({ days: rows.map((r) => ({ date: ymd(r.day), data: r.data, updatedAt: r.updated_at })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "일별 집계 조회 중 오류가 발생했습니다." });
  }
});

// PUT /gs-daily/:date  body: { data: { products: [...] } } - 그 날짜 스냅샷 통째로 교체
router.put("/:date", async (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)." });
  const data = req.body && req.body.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return res.status(400).json({ error: "data 객체가 필요합니다." });
  const json = JSON.stringify(data);
  if (json.length > 2000000) return res.status(400).json({ error: "데이터가 너무 큽니다." });
  try {
    await ensureTable();
    await pool.query(
      `INSERT INTO gs_daily_totals (day, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (day) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [date, json]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "일별 집계 저장 중 오류가 발생했습니다." });
  }
});

// DELETE /gs-daily/:date - 그 날짜 스냅샷 삭제 (주문정보에서 "이 날짜 삭제"할 때 같이 지움)
router.delete("/:date", async (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)." });
  try {
    await ensureTable();
    await pool.query("DELETE FROM gs_daily_totals WHERE day = $1", [date]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "일별 집계 삭제 중 오류가 발생했습니다." });
  }
});

module.exports = router;
