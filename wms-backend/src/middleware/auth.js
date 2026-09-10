const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다." });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, username, name }
    next();
  } catch (e) {
    return res.status(401).json({ error: "토큰이 유효하지 않거나 만료되었습니다." });
  }
}

module.exports = { requireAuth };
