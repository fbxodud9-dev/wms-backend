const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// POST /auth/login { username, password }
router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "아이디와 비밀번호를 입력해주세요." });
  }
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });

    const payload = { id: user.id, username: user.username, name: user.name };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
  }
});

// GET /auth/me - 토큰으로 현재 로그인된 사용자 정보 확인
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /auth/change-password { currentPassword, newPassword }
router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "현재 비밀번호와 6자 이상의 새 비밀번호를 입력해주세요." });
  }
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    const user = rows[0];
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다." });
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [newHash, user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "비밀번호 변경 중 오류가 발생했습니다." });
  }
});

module.exports = router;
