CREATE TABLE IF NOT EXISTS order_rejections (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    technician_id INTEGER NOT NULL REFERENCES technicians(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(order_id, technician_id)
);
