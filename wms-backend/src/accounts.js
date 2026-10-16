// 직원 계정·권한·작업 기록 (2026-10-17)
// - users 표에 역할(role)·권한(perms)·사용 여부(active)·첫 로그인 비밀번호 변경(must_change) 칸을 더한다 (여러 번 실행해도 안전)
// - 예전부터 있던 계정(공용 임시 아이디 등)은 관리자(admin)로 둔다
// - audit_logs 표: 누가 언제 무엇을 했는지 (로그인, 발주파일 업로드, 날짜 삭제, 수량 수정, 설정 변경, 다운로드 등)
const pool = require("./db");

// 권한 목록 (관리자 = 전부). 화면의 계정 관리에서 사람마다 체크해서 준다
const PERMS = ["upload", "edit", "delete", "settings", "accounts", "logs"];

let ready = null;
function ensureAccounts() {
  if (!ready) {
    ready = (async () => {
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT");
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS perms JSONB NOT NULL DEFAULT '[]'::jsonb");
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true");
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change BOOLEAN NOT NULL DEFAULT false");
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ");
      // 역할이 비어 있는 계정 = 이 기능 전에 만든 계정 → 관리자
      await pool.query("UPDATE users SET role = 'admin' WHERE role IS NULL");
      await pool.query(
        `CREATE TABLE IF NOT EXISTS audit_logs (
           id BIGSERIAL PRIMARY KEY,
           at TIMESTAMPTZ NOT NULL DEFAULT now(),
           user_id UUID,
           username TEXT,
           name TEXT,
           action TEXT NOT NULL,
           target TEXT,
           detail JSONB NOT NULL DEFAULT '{}'::jsonb,
           ip TEXT
         )`
      );
      await pool.query("CREATE INDEX IF NOT EXISTS audit_logs_at_idx ON audit_logs (at DESC)");
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by TEXT");
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

function can(user, perm) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return Array.isArray(user.perms) && user.perms.includes(perm);
}

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role || "staff",
    perms: Array.isArray(row.perms) ? row.perms : [],
    active: row.active !== false,
    mustChange: !!row.must_change,
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at || null,
  };
}

function ipOf(req) {
  const f = req && req.headers && req.headers["x-forwarded-for"];
  return (f ? String(f).split(",")[0].trim() : req && (req.ip || (req.socket && req.socket.remoteAddress))) || null;
}

// 작업 기록 남기기 (실패해도 원래 작업은 그대로 진행)
async function audit(req, action, target, detail, who) {
  try {
    await ensureAccounts();
    const u = who || (req && req.user) || {};
    await pool.query("INSERT INTO audit_logs (user_id, username, name, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)", [
      u.id || null,
      u.username || null,
      u.name || null,
      String(action).slice(0, 60),
      target == null ? null : String(target).slice(0, 300),
      JSON.stringify(detail || {}).slice(0, 20000),
      ipOf(req),
    ]);
  } catch (e) {
    console.error("작업 기록 실패:", e.message);
  }
}

module.exports = { PERMS, ensureAccounts, can, publicUser, audit };
