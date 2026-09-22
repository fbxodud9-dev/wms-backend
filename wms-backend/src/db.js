const { Pool, types } = require("pg");

// PostgreSQL DATE 타입(OID 1082)을 JS Date 객체로 자동 변환하지 않고 "YYYY-MM-DD" 문자열 그대로 받음
// (자동 변환 시 서버 시간대에 따라 날짜가 하루 밀리는 문제가 생길 수 있어 방지)
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => {
  console.error("예기치 않은 DB 에러:", err);
});

module.exports = pool;
