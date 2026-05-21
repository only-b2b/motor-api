CREATE TABLE IF NOT EXISTS user_addresses (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL,

  label VARCHAR(50) DEFAULT 'Home',
  address TEXT NOT NULL,
  city VARCHAR(50) NOT NULL,

  latitude NUMERIC(10,6),
  longitude NUMERIC(10,6),

  is_default BOOLEAN DEFAULT FALSE,
  last_used_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_user_addresses
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
);
