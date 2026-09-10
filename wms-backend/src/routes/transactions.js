const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// GET /transactions?limit=200 - 입출고 이력 (최신순)
router.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  try {
    const { rows } = await pool.query(
      "SELECT * FROM transactions ORDER BY created_at DESC, id DESC LIMIT $1",
      [limit]
    );
    res.json({ transactions: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "입출고 이력 조회 중 오류가 발생했습니다." });
  }
});

module.exports = router;
