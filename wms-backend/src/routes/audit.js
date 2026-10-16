// 작업 기록: 화면에서 일어난 일(다운로드·2차 검증 결과·업로드 선택 등) 남기기 + 조회 (조회 권한: logs)
const express = require("express");
const pool = require("../db");
const { requireAuth, requirePerm } = require("../middleware/auth");
const { ensureAccounts, audit } = require("../accounts");

const router = express.Router();
router.use(requireAuth);

// POST /audit { action, target, detail } - 화면 기록 (action은 "ui." 으로 시작하게 저장)
router.post("/", async (req, res) => {
  const { action, target, detail } = req.body || {};
  if (!/^[a-z0-9_.]{2,50}$/.test(String(action || ""))) return res.status(400).json({ error: "기록 종류가 올바르지 않습니다." });
  await audit(req, "ui." + String(action).replace(/^ui\./, ""), target, detail && typeof detail === "object" ? detail : {});
  res.json({ ok: true });
});

// GET /audit?from=YYYY-MM-DD&to=YYYY-MM-DD&user=아이디&action=종류&q=검색어&limit=200&offset=0
router.get("/", requirePerm("logs"), async (req, res) => {
  const { from, to, user, action, q } = req.query;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const where = [];
  const vals = [];
  const add = (sql, v) => {
    vals.push(v);
    where.push(sql.replace("?", "$" + vals.length));
  };
  // 날짜는 한국 시간 기준
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || "")) add("at >= ?::timestamptz", `${from}T00:00:00+09:00`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
    const d = new Date(`${to}T00:00:00+09:00`);
    d.setUTCDate(d.getUTCDate() + 1);
    add("at < ?::timestamptz", d.toISOString());
  }
  if (user) add("username = ?", String(user));
  if (action) add("action LIKE ?", String(action).replace(/[%_]/g, "") + "%");
  if (q) {
    const n = "$" + (vals.length + 1);
    add(`(target ILIKE ? OR detail::text ILIKE ${n} OR name ILIKE ${n} OR username ILIKE ${n})`, "%" + String(q) + "%");
  }
  try {
    await ensureAccounts();
    const sql = `SELECT id, at, username, name, action, target, detail, ip FROM audit_logs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`;
    const { rows } = await pool.query(sql, vals);
    res.json({ logs: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "작업 기록을 불러오지 못했습니다." });
  }
});

module.exports = router;
