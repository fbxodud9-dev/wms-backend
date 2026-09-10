require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const itemRoutes = require("./routes/items");
const orderRoutes = require("./routes/orders");
const transactionRoutes = require("./routes/transactions");

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

// 공통 에러 핸들러
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "서버 오류가 발생했습니다." });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`WMS 백엔드 서버가 포트 ${PORT}에서 실행 중입니다.`);
});
