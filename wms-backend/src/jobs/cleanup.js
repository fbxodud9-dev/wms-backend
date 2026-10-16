const pool = require("../db");

// 오래된 발주(업로드 기록)를 자동으로 지운다. 기본 14일 보관 (Render 환경변수 RETENTION_DAYS로 바꿀 수 있음).
// 발주를 지우면 그 발주의 품목 라인(order_lines)과 피킹지시서 기록(picking_docs)도 ON DELETE CASCADE로 같이 지워진다.
// 기준 날짜는 발주일(order_date, 한국 시간). 예: 14일 보관이면 9/24 발주는 10/08에 지워진다.
// 상품마스터·재고·입출고 이력·물동량·설정값(피킹지 순서, 상품 정보)은 건드리지 않는다.
const RETENTION_DAYS = Math.max(1, parseInt(process.env.RETENTION_DAYS || "14", 10) || 14);
const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6시간마다 (서버가 잠들었다 깨어날 때도 시작하자마자 한 번 실행)

// 한국 시간 기준 오늘에서 RETENTION_DAYS일 뺀 날짜 (YYYY-MM-DD). 이 날짜 이하 발주가 삭제 대상.
function cutoffDate(now = Date.now()) {
  const kst = new Date(now + 9 * 60 * 60 * 1000);
  kst.setUTCDate(kst.getUTCDate() - RETENTION_DAYS);
  return kst.toISOString().slice(0, 10);
}

async function cleanupOldOrders() {
  try {
    const cutoff = cutoffDate();
    const { rows } = await pool.query(
      `WITH del AS (
         DELETE FROM orders
         WHERE order_date <= $1::date
         RETURNING order_date
       )
       SELECT count(*)::int AS n, min(order_date) AS min_date, max(order_date) AS max_date FROM del`,
      [cutoff]
    );
    const r = rows[0] || {};
    if (r.n > 0) console.log(`[자동정리] ${RETENTION_DAYS}일 지난 발주 ${r.n}건 삭제 (${r.min_date} ~ ${r.max_date})`);
    return r.n || 0;
  } catch (e) {
    console.error("[자동정리] 오래된 발주 삭제 실패:", e.message);
    return 0;
  }
}

// 작업 기록은 1년(AUDIT_RETENTION_DAYS)만 보관
const AUDIT_RETENTION_DAYS = Math.max(30, parseInt(process.env.AUDIT_RETENTION_DAYS || "365", 10) || 365);
async function cleanupOldAudit() {
  try {
    const r = await pool.query(`DELETE FROM audit_logs WHERE at < now() - ($1::int * interval '1 day')`, [AUDIT_RETENTION_DAYS]);
    if (r.rowCount > 0) console.log(`[자동정리] ${AUDIT_RETENTION_DAYS}일 지난 작업 기록 ${r.rowCount}건 삭제`);
  } catch (e) {
    if (!/does not exist/.test(e.message)) console.error("[자동정리] 작업 기록 삭제 실패:", e.message);
  }
}

function startCleanupJob() {
  setTimeout(cleanupOldAudit, 20 * 1000);
  setInterval(cleanupOldAudit, INTERVAL_MS);
  setTimeout(cleanupOldOrders, 10 * 1000); // 서버 시작 10초 뒤 첫 실행
  setInterval(cleanupOldOrders, INTERVAL_MS);
}

module.exports = { startCleanupJob, cleanupOldOrders, cutoffDate, RETENTION_DAYS };
