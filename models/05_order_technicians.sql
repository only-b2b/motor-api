CREATE TABLE IF NOT EXISTS order_technicians (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id) ON DELETE CASCADE,
  technician_id INT REFERENCES technicians(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW()
);
