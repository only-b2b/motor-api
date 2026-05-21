-- =========================
-- 03_orders.sql
-- =========================

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,

  user_id INTEGER NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  address_id INTEGER
    REFERENCES user_addresses(id)
    ON DELETE SET NULL,

  service_type VARCHAR(50) NOT NULL,      -- Car Wash / Pick & Drop / Driver Booking
  vehicle VARCHAR(50),

  package_name VARCHAR(50),               -- ✅ (DON'T use column name "package")
  hub_name VARCHAR(100),
  distance VARCHAR(50),
  duration VARCHAR(50),

  price INTEGER NOT NULL CHECK (price >= 0),

  status VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'requested',
        'accepted',
        'arrived',
        'in_progress',
        'completed',
        'cancelled'
      )
    ),

  payment_mode VARCHAR(20)
    CHECK (payment_mode IN ('upi','cash','online')),

  payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','paid','refunded')),


  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
