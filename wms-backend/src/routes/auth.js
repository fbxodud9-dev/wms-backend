const jwt = require("jsonwebtoken");
const pool = require("../db");
const { ensureAccounts, can } = require("../accounts");

// 계정 정보(권한·사용 여부)는 잠깐(20초) 기억해서 요청마다 DB를 읽지 않게 한다
const CACHE_MS = 20 * 1000;
const cache = new Map();
function forgetUser(id) {
  cache.delete(id);
}

async function loadUser(id) {
  const c = cache.get(id);
  if (c && Date.now() - c.t < CACHE_MS) return c.row;
  await ensureAccounts();
  const { rows } = await pool.query("SELECT id, username, name, role, perms, active, must_change FROM users WHERE id = $1", [id]);
  const row = rows[0] || null;
  cache.set(id, { row, t: Date.now() });
  return row;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다." });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: "토큰이 유효하지 않거나 만료되었습니다." });
  }
  try {
    const row = await loadUser(payload.id);
    if (!row) return res.status(401).json({ error: "계정을 찾을 수 없어요. 다시 로그인해주세요." });
    if (row.active === false) return res.status(401).json({ error: "사용이 중지된 계정이에요. 관리자에게 문의해주세요." });
    req.user = { id: row.id, username: row.username, name: row.name, role: row.role || "staff", perms: Array.isArray(row.perms) ? row.perms : [], mustChange: !!row.must_change };
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "계정 확인 중 오류가 발생했습니다." });
  }
}

// 권한 검사: requirePerm("delete") / requirePerm("upload", "edit") = 둘 중 하나라도 있으면 통과
function requirePerm(...perms) {
  return (req, res, next) => {
    if (perms.some((p) => can(req.user, p))) return next();
    res.status(403).json({ error: "이 작업 권한이 없어요. 관리자에게 권한을 요청해주세요." });
  };
}

module.exports = { requireAuth, requirePerm, forgetUser };
