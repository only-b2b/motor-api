CREATE TABLE IF NOT EXISTS tech_documents (
  id SERIAL PRIMARY KEY,
  technician_id INTEGER REFERENCES technicians(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  doc_number TEXT,          -- ⭐ NEW
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);
