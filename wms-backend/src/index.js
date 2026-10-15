require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const itemRoutes = require("./routes/items");
const orderRoutes = require("./routes/orders");
const transactionRoutes = require("./routes/transactions");
const volumeRoutes = require("./routes/volumes");
const settingsRoutes = require("./routes/settings");

const app = express();

// 프론트엔드(Vercel) 주소만 허용. 콤마로 여러 개 등록 가능 (예: 로컬 개발 주소 추가)
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // 서버-서버 요청이나 Postman 등 origin이 없는 요청은 허용
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error("허용되지 않은 접속 경로입니다 (CORS)."));
    },
  })
);
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => res.json({ ok: true, service: "wms-backend" }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/auth", authRoutes);
app.use("/items", itemRoutes);
app.use("/orders", orderRoutes);
app.use("/transactions", transactionRoutes);
app.use("/volumes", volumeRoutes);
app.use("/settings", settingsRoutes);

// 공통 에러 핸들러
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "서버 오류가 발생했습니다." });
});

// 서버 켤 때 할 일
// 1) 보조 서버(SITE_ROLE=backup)이고 COPY_FROM_MAIN_ON_START가 있으면 본 DB 데이터를 보조 DB로 복사
//    - "yes": 보조 DB가 비어 있을 때만 (처음 한 번) / "force": 켤 때마다 항상 새로 복사 (보조 DB 테스트 데이터는 지워짐)
//    - 본 서버에서는 SITE_ROLE이 없어서 절대 실행되지 않음. 본 DB는 읽기만 함
// 2) 필요한 칸 자동 추가 (여러 번 실행해도 안전) - 2026-10-15 냉동 피킹지 납품일자
async function bootDb() {
  const db = require("./db");
  const mode = String(process.env.COPY_FROM_MAIN_ON_START || "").trim().toLowerCase();
  if (process.env.SITE_ROLE === "backup" && (mode === "yes" || mode === "force")) {
    let empty = true;
    try {
      const r = await db.query("SELECT COUNT(*)::int AS n FROM users");
      empty = r.rows[0].n === 0;
    } catch (e) {
      empty = true; // 표가 아직 없음 = 빈 DB
    }
    if (mode === "force" || empty) {
      console.log("본 DB -> 보조 DB 복사를 시작합니다...");
      await new Promise((resolve) => {
        const child = require("child_process").fork(require("path").join(__dirname, "..", "sql", "copy-from-main.js"));
        child.on("exit", (code) => {
          console.log(code === 0 ? "본 DB -> 보조 DB 복사 끝" : `본 DB -> 보조 DB 복사 실패 (코드 ${code}) - 위 로그를 확인하세요`);
          resolve();
        });
      });
    } else {
      console.log("보조 DB에 이미 데이터가 있어서 복사를 건너뜁니다. (다시 복사하려면 COPY_FROM_MAIN_ON_START=force)");
    }
  }
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_date DATE").catch((e) => console.error("delivery_date 칸 추가 실패:", e.message));
}
bootDb().catch((e) => console.error("서버 시작 작업 실패:", e.message));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`WMS 백엔드 서버가 포트 ${PORT}에서 실행 중입니다.`);
});
