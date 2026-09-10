-- WMS 허브센터 핵심 스키마 (주문정보 · 상품할당 · 피킹 · 출고)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  location TEXT,
  unit TEXT DEFAULT 'EA',
  qty INTEGER NOT NULL DEFAULT 0,
  safety INTEGER NOT NULL DEFAULT 0,
  temp_zone TEXT DEFAULT '상온',
  work_type TEXT DEFAULT '피킹',
  unit_qty INTEGER DEFAULT 1,
  box_qty INTEGER DEFAULT 1,
  cbm NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no TEXT UNIQUE NOT NULL,
  customer TEXT NOT NULL,
  store_code TEXT,
  supplier TEXT,
  supplier_code TEXT,
  channel TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'ALLOCATED', 'PICK_CONFIRMED', 'SHIPPED', 'DONE')),
  pick_doc_no TEXT,
  pms_status TEXT,
  invoice_issued BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  changed_qty INTEGER NOT NULL,
  allocated_qty INTEGER NOT NULL DEFAULT 0,
  alloc_status TEXT NOT NULL DEFAULT '미할당',
  location TEXT DEFAULT '-',
  unit TEXT DEFAULT 'EA',
  pack_qty INTEGER DEFAULT 0,
  picked BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('IN', 'OUT')),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  location TEXT,
  tx_date DATE NOT NULL DEFAULT CURRENT_DATE,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS picking_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no TEXT UNIQUE NOT NULL,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  customer TEXT NOT NULL,
  doc_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT '확정',
  reprints INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_order_lines_order_id ON order_lines(order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_items_sku ON items(sku);
