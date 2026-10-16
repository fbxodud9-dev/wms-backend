// 계정 관리 (권한: accounts). 관리자가 직원 아이디를 만들고 권한을 체크해서 준다
const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const { requireAuth, requirePerm, forgetUser } = require("../middleware/auth");
const { PERMS, ensureAccounts, publicUser, audit } = require("../accounts");

const router = express.Router();
router.use(requireAuth, requirePerm("accounts"));

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,30}$/;
const cleanPerms = (p) => (Array.isArray(p) ? Array.from(new Set(p.filter((x) => PERMS.includes(x)))) : []);
const cleanRole = (r) => (r === "admin" ? "admin" : "staff");

async function activeAdminCount(exceptId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND active = true AND id <> $1", [exceptId || "00000000-0000-0000-0000-000000000000"]);
  return rows[0].n;
}

// GET /users - 계정 목록
router.get("/", async (req, res) => {
  try {
    await ensureAccounts();
    const { rows } = await pool.query("SELECT * FROM users ORDER BY (role = 'admin') DESC, active DESC, name");
    res.json({ users: rows.map(publicUser), perms: PERMS });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "계정 목록을 불러오지 못했습니다." });
  }
});

// POST /users { username, name, password, role, perms } - 새 계정 (첫 로그인 때 비밀번호를 바꾸게 함)
router.post("/", async (req, res) => {
  const { username, name, password } = req.body || {};
  const role = cleanRole(req.body && req.body.role);
  const perms = cleanPerms(req.body && req.body.perms);
  if (!USERNAME_RE.test(String(username || ""))) return res.status(400).json({ error: "아이디는 영문·숫자·._- 로 3~30자예요." });
  if (!String(name || "").trim()) return res.status(400).json({ error: "이름을 입력해주세요." });
  if (!password || String(password).length < 6) return res.status(400).json({ error: "임시 비밀번호는 6자 이상이에요." });
  if (role === "admin" && req.user.role !== "admin") return res.status(403).json({ error: "관리자 계정은 관리자만 만들 수 있어요." });
  try {
    await ensureAccounts();
    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await pool.query(
      "INSERT INTO users (username, password_hash, name, role, perms, active, must_change) VALUES ($1, $2, $3, $4, $5::jsonb, true, true) RETURNING *",
      [String(username).trim(), hash, String(name).trim(), role, JSON.stringify(perms)]
    );
    await audit(req, "user_create", rows[0].username, { name: rows[0].name, role, perms });
    res.status(201).json({ user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "이미 있는 아이디예요." });
    console.error(e);
    res.status(500).json({ error: "계정을 만들지 못했습니다." });
  }
});

// PATCH /users/:id { name?, role?, perms?, active? }
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const b = req.body || {};
  try {
    await ensureAccounts();
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    const cur = rows[0];
    if (!cur) return res.status(404).json({ error: "계정을 찾을 수 없어요." });
    const next = {
      name: b.name != null ? String(b.name).trim() || cur.name : cur.name,
      role: b.role != null ? cleanRole(b.role) : cur.role || "staff",
      perms: b.perms != null ? cleanPerms(b.perms) : cur.perms || [],
      active: b.active != null ? !!b.active : cur.active !== false,
    };
    const isSelf = cur.id === req.user.id;
    if ((cur.role === "admin" || next.role === "admin") && req.user.role !== "admin") return res.status(403).json({ error: "관리자 계정은 관리자만 바꿀 수 있어요." });
    if (isSelf && (!next.active || next.role !== cur.role)) return res.status(400).json({ error: "내 계정의 역할·사용 여부는 직접 바꿀 수 없어요." });
    if (cur.role === "admin" && cur.active !== false && (next.role !== "admin" || !next.active) && (await activeAdminCount(cur.id)) === 0)
      return res.status(400).json({ error: "관리자가 한 명은 있어야 해요." });
    const { rows: up } = await pool.query("UPDATE users SET name = $2, role = $3, perms = $4::jsonb, active = $5 WHERE id = $1 RETURNING *", [
      id,
      next.name,
      next.role,
      JSON.stringify(next.perms),
      next.active,
    ]);
    forgetUser(id);
    const changes = {};
    ["name", "role", "active"].forEach((k) => String(cur[k]) !== String(next[k]) && (changes[k] = { from: cur[k], to: next[k] }));
    if (JSON.stringify(cur.perms || []) !== JSON.stringify(next.perms)) changes.perms = { from: cur.perms || [], to: next.perms };
    await audit(req, "user_update", cur.username, changes);
    res.json({ user: publicUser(up[0]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "계정을 바꾸지 못했습니다." });
  }
});

// POST /users/:id/reset-password { password } - 임시 비밀번호로 초기화 (다음 로그인 때 바꾸게 함)
router.post("/:id/reset-password", async (req, res) => {
  const { id } = req.params;
  const password = req.body && req.body.password;
  if (!password || String(password).length < 6) return res.status(400).json({ error: "임시 비밀번호는 6자 이상이에요." });
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    const cur = rows[0];
    if (!cur) return res.status(404).json({ error: "계정을 찾을 수 없어요." });
    if (cur.role === "admin" && req.user.role !== "admin") return res.status(403).json({ error: "관리자 계정은 관리자만 초기화할 수 있어요." });
    const hash = await bcrypt.hash(String(password), 10);
    await pool.query("UPDATE users SET password_hash = $2, must_change = true WHERE id = $1", [id, hash]);
    forgetUser(id);
    await audit(req, "user_reset_password", cur.username, {});
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "비밀번호를 초기화하지 못했습니다." });
  }
});

module.exports = router;
