const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

function genOrderNo() {
  return `ORD-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}
function genDocNo() {
  return `PICK-${Date.now().toString(36).toUpperCase().slice(-7)}`;
}

async function getOrderWithLines(client, orderId) {
  const oRes = await client.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  if (oRes.rows.length === 0) return null;
  const lRes = await client.query("SELECT * FROM order_lines WHERE order_id = $1 ORDER BY sku", [orderId]);
  return { ...oRes.rows[0], lines: lRes.rows };
}

// ---------- 1. 발주정보 ----------

// GET /orders?status=NEW - 전체 발주 목록(라인 포함) 조회
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    const oRes = status
      ? await pool.query("SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC", [status])
      : await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    const orders = oRes.rows;
    if (orders.length === 0) return res.json({ orders: [] });
    const ids = orders.map((o) => o.id);
    const lRes = await pool.query("SELECT * FROM order_lines WHERE order_id = ANY($1::uuid[])", [ids]);
    const linesByOrder = {};
    lRes.rows.forEach((l) => {
      (linesByOrder[l.order_id] = linesByOrder[l.order_id] || []).push(l);
    });
    res.json({ orders: orders.map((o) => ({ ...o, lines: linesByOrder[o.id] || [] })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "발주 목록 조회 중 오류가 발생했습니다." });
  }
});

// POST /orders - 발주 등록 (엑셀 업로드 파싱 결과 또는 수동 입력을 그대로 받음)
// body: { orderNo?, customer, storeCode?, supplier?, supplierCode?, channel?, lines: [{sku, name, qty, packQty, location, unit}] }
router.post("/", async (req, res) => {
  const { orderNo, customer, storeCode, supplier, supplierCode, channel, lines } = req.body || {};
  if (!customer || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "발주처(customer)와 최소 1개 이상의 품목 라인이 필요합니다." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const finalOrderNo = orderNo || genOrderNo();
    // 할당 단계 없이 등록과 동시에 100% 할당 완료 상태로 생성 (재고 체크 없음, 크로스도킹 정책)
    const oRes = await client.query(
      `INSERT INTO orders (order_no, customer, store_code, supplier, supplier_code, channel, status)
       VALUES ($1,$2,$3,$4,$5,$6,'ALLOCATED') RETURNING *`,
      [finalOrderNo, customer, storeCode || null, supplier || null, supplierCode || null, channel || null]
    );
    const order = oRes.rows[0];
    for (const l of lines) {
      if (!l.sku || !l.qty || l.qty <= 0) continue;
      const itemRes = await client.query("SELECT location FROM items WHERE sku = $1", [l.sku]);
      const location = itemRes.rows[0] ? itemRes.rows[0].location : l.location || "-";
      await client.query(
        `INSERT INTO order_lines (order_id, sku, name, qty, changed_qty, allocated_qty, alloc_status, location, unit, pack_qty, picked)
         VALUES ($1,$2,$3,$4,$4,$4,'할당',$5,$6,$7,false)`,
        [order.id, l.sku, l.name || l.sku, l.qty, location, l.unit || "EA", l.packQty || 0]
      );
    }
    await client.query("COMMIT");
    const full = await getOrderWithLines(pool, order.id);
    res.status(201).json({ order: full });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "발주 등록 중 오류가 발생했습니다." });
  } finally {
    client.release();
  }
});

// POST /orders/bulk - 여러 발주를 한 번의 요청/트랜잭션으로 등록 (엑셀 업로드처럼 대량 등록 시 사용)
router.post("/bulk", async (req, res) => {
  const { orders } = req.body || {};
  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ error: "orders 배열이 필요합니다." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 이번 요청에서 조회한 품목 위치는 캐싱해서 반복 조회를 줄임
    const locationCache = new Map();
    async function getLocation(sku, fallback) {
      if (locationCache.has(sku)) return locationCache.get(sku);
      const itemRes = await client.query("SELECT location FROM items WHERE sku = $1", [sku]);
      const loc = itemRes.rows[0] ? itemRes.rows[0].location : fallback || "-";
      locationCache.set(sku, loc);
      return loc;
    }

    let createdCount = 0;
    const skipped = [];
    for (const o of orders) {
      const { orderNo, customer, storeCode, supplier, supplierCode, channel, lines } = o || {};
      if (!customer || !Array.isArray(lines) || lines.length === 0) continue;
      const finalOrderNo = orderNo || genOrderNo();
      let orderRow;
      try {
        const oRes = await client.query(
          `INSERT INTO orders (order_no, customer, store_code, supplier, supplier_code, channel, status)
           VALUES ($1,$2,$3,$4,$5,$6,'ALLOCATED') RETURNING *`,
          [finalOrderNo, customer, storeCode || null, supplier || null, supplierCode || null, channel || null]
        );
        orderRow = oRes.rows[0];
      } catch (e) {
        // 발주번호 중복(unique 제약) 등은 건너뛰고 계속 진행
        skipped.push(finalOrderNo);
        continue;
      }
      for (const l of lines) {
        if (!l.sku || !l.qty || l.qty <= 0) continue;
        const location = await getLocation(l.sku, l.location);
        await client.query(
          `INSERT INTO order_lines (order_id, sku, name, qty, changed_qty, allocated_qty, alloc_status, location, unit, pack_qty, picked)
           VALUES ($1,$2,$3,$4,$4,$4,'할당',$5,$6,$7,false)`,
          [orderRow.id, l.sku, l.name || l.sku, l.qty, location, l.unit || "EA", l.packQty || 0]
        );
      }
      createdCount++;
    }

    await client.query("COMMIT");
    res.status(201).json({ createdCount, skippedCount: skipped.length, skippedOrderNos: skipped });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "발주 일괄 등록 중 오류가 발생했습니다." });
  } finally {
    client.release();
  }
});

// POST /orders/bulk-register-items - 여러 미등록 품목을 한 번에 "미배정" 상태로 등록 (파일 업로드 시 사용)
router.post("/bulk-register-items", async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items 배열이 필요합니다." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const it of items) {
      if (!it.sku) continue;
      await client.query(
        `INSERT INTO items (sku, name, category, location, unit, qty, safety, temp_zone, work_type, unit_qty, box_qty, cbm)
         VALUES ($1,$2,NULL,'미배정','EA',0,0,'상온','피킹',1,1,0)
         ON CONFLICT (sku) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
        [it.sku, it.name || it.sku]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "품목 일괄 등록 중 오류가 발생했습니다." });
  } finally {
    client.release();
  }
});

router.patch("/:id/lines/:sku", async (req, res) => {
  const { id, sku } = req.params;
  const { changedQty } = req.body || {};
  if (changedQty == null || changedQty < 0) return res.status(400).json({ error: "올바른 수량을 입력해주세요." });
  try {
    const oRes = await pool.query("SELECT status FROM orders WHERE id = $1", [id]);
    if (oRes.rows.length === 0) return res.status(404).json({ error: "발주를 찾을 수 없습니다." });
    if (!["NEW", "ALLOCATED"].includes(oRes.rows[0].status)) {
      return res.status(400).json({ error: "피킹이 시작되기 전(할당 상태)까지만 수량을 수정할 수 있습니다." });
    }
    // 할당 단계가 없으므로 수량 변경 시 할당수량도 함께 100%로 재계산
    await pool.query("UPDATE order_lines SET changed_qty = $1, allocated_qty = $1, alloc_status = '할당' WHERE order_id = $2 AND sku = $3", [changedQty, id, sku]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "수량 수정 중 오류가 발생했습니다." });
  }
});

// ---------- 2. 피킹지시서변환 (공급사 단위 일괄 할당) ----------

// POST /orders/convert-to-picking { supplierKey }  (supplierKey = supplier_code || supplier)
router.post("/convert-to-picking", async (req, res) => {
  const { supplierKey } = req.body || {};
  if (!supplierKey) return res.status(400).json({ error: "supplierKey가 필요합니다." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const targets = await client.query(
      `SELECT * FROM orders WHERE status = 'NEW' AND (supplier_code = $1 OR supplier = $1)`,
      [supplierKey]
    );
    const convertedIds = [];
    for (const order of targets.rows) {
      const linesRes = await client.query("SELECT * FROM order_lines WHERE order_id = $1", [order.id]);
      for (const line of linesRes.rows) {
        const itemRes = await client.query("SELECT location FROM items WHERE sku = $1", [line.sku]);
        const location = itemRes.rows[0] ? itemRes.rows[0].location : line.location;
        // 재고 체크 없이 요청수량을 그대로 100% 할당 (크로스도킹: 당일 입고 후 바로 출고되는 품목이 많음)
        const allocatedQty = line.changed_qty;
        const allocStatus = "할당";
        await client.query("UPDATE order_lines SET allocated_qty = $1, alloc_status = $2, location = $3 WHERE id = $4", [allocatedQty, allocStatus, location, line.id]);
      }
      await client.query("UPDATE orders SET status = 'ALLOCATED' WHERE id = $1", [order.id]);
      convertedIds.push(order.id);
    }
    await client.query("COMMIT");
    res.json({ convertedCount: convertedIds.length, orderIds: convertedIds });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "피킹지시서 변환 중 오류가 발생했습니다." });
  } finally {
    client.release();
  }
});

// POST /orders/:id/allocate - 발주 1건 단위 할당 (필요 시 개별 사용)
router.post("/:id/allocate", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const linesRes = await client.query("SELECT * FROM order_lines WHERE order_id = $1", [id]);
    if (linesRes.rows.length === 0) throw new Error("발주를 찾을 수 없습니다.");
    for (const line of linesRes.rows) {
      const itemRes = await client.query("SELECT location FROM items WHERE sku = $1", [line.sku]);
      const location = itemRes.rows[0] ? itemRes.rows[0].location : line.location;
      const allocatedQty = line.changed_qty;
      const allocStatus = "할당";
      await client.query("UPDATE order_lines SET allocated_qty = $1, alloc_status = $2, location = $3 WHERE id = $4", [allocatedQty, allocStatus, location, line.id]);
    }
    await client.query("UPDATE orders SET status = 'ALLOCATED' WHERE id = $1", [id]);
    await client.query("COMMIT");
    const full = await getOrderWithLines(pool, id);
    res.json({ order: full });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /orders/:id/lines/:sku/cancel-allocation - 할당리스트에서 라인 단위 할당취소
router.post("/:id/lines/:sku/cancel-allocation", async (req, res) => {
  const { id, sku } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE order_lines SET allocated_qty = 0, alloc_status = '미할당' WHERE order_id = $1 AND sku = $2",
      [id, sku]
    );
    const linesRes = await client.query("SELECT allocated_qty FROM order_lines WHERE order_id = $1", [id]);
    const anyAllocated = linesRes.rows.some((l) => l.allocated_qty > 0);
    const orderRes = await client.query("SELECT status FROM orders WHERE id = $1", [id]);
    if (orderRes.rows[0] && orderRes.rows[0].status === "ALLOCATED" && !anyAllocated) {
      await client.query("UPDATE orders SET status = 'NEW' WHERE id = $1", [id]);
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- 3. 피킹 ----------

// PATCH /orders/:id/lines/:sku/pick { picked }
router.patch("/:id/lines/:sku/pick", async (req, res) => {
  const { id, sku } = req.params;
  const { picked } = req.body || {};
  try {
    const oRes = await pool.query("SELECT status FROM orders WHERE id = $1", [id]);
    if (oRes.rows.length === 0) return res.status(404).json({ error: "발주를 찾을 수 없습니다." });
    if (oRes.rows[0].status !== "ALLOCATED") return res.status(400).json({ error: "할당된 발주만 피킹 체크가 가능합니다." });
    await pool.query("UPDATE order_lines SET picked = $1 WHERE order_id = $2 AND sku = $3", [!!picked, id, sku]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "피킹 체크 중 오류가 발생했습니다." });
  }
});

// POST /orders/:id/confirm-pick - 피킹 확정 (지시서 문서번호 발급)
router.post("/:id/confirm-pick", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await getOrderWithLines(client, id);
    if (!order) throw new Error("발주를 찾을 수 없습니다.");
    if (order.status !== "ALLOCATED") throw new Error("할당된 발주만 확정할 수 있습니다.");
    const pickable = order.lines.filter((l) => l.allocated_qty > 0);
    if (pickable.length === 0) throw new Error("할당된 품목이 없어 확정할 수 없습니다.");
    if (!pickable.every((l) => l.picked)) throw new Error("모든 품목을 피킹 체크해야 확정할 수 있습니다.");

    const docNo = genDocNo();
    await client.query("UPDATE orders SET status = 'PICK_CONFIRMED', pick_doc_no = $1 WHERE id = $2", [docNo, id]);
    await client.query(
      `INSERT INTO picking_docs (doc_no, order_id, order_no, customer, status) VALUES ($1,$2,$3,$4,'확정')`,
      [docNo, id, order.order_no, order.customer]
    );
    await client.query("COMMIT");
    res.json({ docNo });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /orders/:id/cancel-pick
router.post("/:id/cancel-pick", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const oRes = await client.query("SELECT * FROM orders WHERE id = $1", [id]);
    if (oRes.rows.length === 0) throw new Error("발주를 찾을 수 없습니다.");
    const order = oRes.rows[0];
    if (order.status !== "PICK_CONFIRMED") throw new Error("피킹확정 상태의 발주만 취소할 수 있습니다.");
    await client.query("UPDATE orders SET status = 'ALLOCATED', pick_doc_no = NULL WHERE id = $1", [id]);
    if (order.pick_doc_no) {
      await client.query("UPDATE picking_docs SET status = '취소' WHERE doc_no = $1", [order.pick_doc_no]);
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /orders/picking-docs
router.get("/picking-docs", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM picking_docs ORDER BY doc_date DESC, doc_no DESC");
    res.json({ docs: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "피킹지시서 목록 조회 중 오류가 발생했습니다." });
  }
});

// POST /orders/picking-docs/:docNo/reissue
router.post("/picking-docs/:docNo/reissue", async (req, res) => {
  const { docNo } = req.params;
  try {
    const { rows } = await pool.query("UPDATE picking_docs SET reprints = reprints + 1 WHERE doc_no = $1 RETURNING *", [docNo]);
    if (rows.length === 0) return res.status(404).json({ error: "지시서를 찾을 수 없습니다." });
    res.json({ doc: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "재발행 처리 중 오류가 발생했습니다." });
  }
});

// ---------- 4. 출고 ----------

// POST /orders/:id/ship
router.post("/:id/ship", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await getOrderWithLines(client, id);
    if (!order) throw new Error("발주를 찾을 수 없습니다.");
    if (order.status !== "PICK_CONFIRMED") throw new Error("피킹확정 상태의 발주만 출고할 수 있습니다.");

    for (const line of order.lines) {
      if (line.allocated_qty <= 0) continue;
      // 재고 부족(또는 0)이어도 출고를 막지 않음 — 당일 입고 후 바로 출고되는 크로스도킹 품목이 많음
      await client.query("UPDATE items SET qty = qty - $1, updated_at = now() WHERE sku = $2", [line.allocated_qty, line.sku]);
      await client.query(
        `INSERT INTO transactions (type, sku, name, qty, location, memo) VALUES ('OUT', $1, $2, $3, $4, $5)`,
        [line.sku, line.name, line.allocated_qty, line.location, `발주 ${order.order_no} 출고 (거래명세서 발행)`]
      );
    }
    await client.query(
      "UPDATE orders SET status = 'SHIPPED', invoice_issued = true, pms_status = '대기', completed_at = now() WHERE id = $1",
      [id]
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /orders/:id/cancel-ship
router.post("/:id/cancel-ship", async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await getOrderWithLines(client, id);
    if (!order) throw new Error("발주를 찾을 수 없습니다.");
    if (order.status !== "SHIPPED") throw new Error("출고완료 상태의 발주만 취소할 수 있습니다.");
    if (order.pms_status === "전송완료") throw new Error("PMS 전송이 완료된 발주는 출고를 취소할 수 없습니다.");

    for (const line of order.lines) {
      if (line.allocated_qty <= 0) continue;
      await client.query("UPDATE items SET qty = qty + $1, updated_at = now() WHERE sku = $2", [line.allocated_qty, line.sku]);
      await client.query(
        `INSERT INTO transactions (type, sku, name, qty, location, memo) VALUES ('IN', $1, $2, $3, $4, $5)`,
        [line.sku, line.name, line.allocated_qty, line.location, `발주 ${order.order_no} 출고취소 재입고`]
      );
    }
    await client.query(
      "UPDATE orders SET status = 'PICK_CONFIRMED', invoice_issued = false, pms_status = NULL, completed_at = NULL WHERE id = $1",
      [id]
    );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /orders/:id/confirm-pms - 출고확정 (PMS 전송완료 처리)
router.post("/:id/confirm-pms", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      "UPDATE orders SET status = 'DONE', pms_status = '전송완료' WHERE id = $1 AND status = 'SHIPPED' RETURNING *",
      [id]
    );
    if (rows.length === 0) return res.status(400).json({ error: "출고완료 상태의 발주만 PMS 전송 확정할 수 있습니다." });
    res.json({ order: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "PMS 전송 확정 중 오류가 발생했습니다." });
  }
});

// DELETE /orders/reset-all - 테스트 데이터 초기화 (모든 발주/라인/피킹지시서 삭제, 품목마스터/재고는 유지)
router.delete("/reset-all", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM picking_docs");
    await client.query("DELETE FROM order_lines");
    await client.query("DELETE FROM orders");
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "초기화 중 오류가 발생했습니다." });
  } finally {
    client.release();
  }
});

module.exports = router;
