const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { requireAuth, forgetUser } = require("../middleware/auth");
const { ensureAccounts, publicUser, audit } = require("../accounts");

const router = express.Router();

// POST /auth/login { username, password }
router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "아이디와 비밀번호를 입력해주세요." });
  }
  try {
    await ensureAccounts();
    const { rows } = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    const user = rows[0];
    const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!ok) {
      await audit(req, "login_fail", username, {}, { username: String(username).slice(0, 60) });
      return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    }
    if (user.active === false) {
      await audit(req, "login_blocked", username, {}, user);
      return res.status(403).json({ error: "사용이 중지된 계정이에요. 관리자에게 문의해주세요." });
    }
    await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    const payload = { id: user.id, username: user.username, name: user.name };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
    await audit(req, "login", user.username, {}, user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "로그인 처리 중 오류가 발생했습니다." });
  }
});

// GET /auth/me - 토큰으로 현재 로그인된 사용자 정보 확인 (권한·첫 로그인 비밀번호 변경 여부 포함)
router.get("/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    res.json({ user: publicUser(rows[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "계정 정보를 불러오지 못했습니다." });
  }
});

// POST /auth/change-password { currentPassword, newPassword }
router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "현재 비밀번호와 6자 이상의 새 비밀번호를 입력해주세요." });
  }
  if (currentPassword === newPassword) return res.status(400).json({ error: "지금 비밀번호와 다른 비밀번호로 바꿔주세요." });
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    const user = rows[0];
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다." });
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password_hash = $1, must_change = false WHERE id = $2", [newHash, user.id]);
    forgetUser(user.id);
    await audit(req, "password_change", user.username, {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "비밀번호 변경 중 오류가 발생했습니다." });
  }
});

module.exports = router;
