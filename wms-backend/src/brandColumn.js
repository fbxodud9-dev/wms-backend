// items 테이블에 brands 컬럼(쉼표로 구분된 브랜드 목록: GS,GSSUPER,EMART,BGF,SEVEN)을 자동으로 추가한다.
const pool = require("./db");

let ready = null;
function ensureBrandColumn() {
  if (!ready) {
    ready = pool.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS brands TEXT").catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

// 기존 브랜드 목록에 새 브랜드를 합친다 (중복 없이). 기존 값이 없으면 GS 로 본다.
function mergeBrands(current, add) {
  const set = new Set(String(current || "GS").split(",").map((s) => s.trim()).filter(Boolean));
  String(add || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((b) => set.add(b));
  return Array.from(set).join(",");
}

module.exports = { ensureBrandColumn, mergeBrands };
