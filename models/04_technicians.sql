CREATE TABLE IF NOT EXISTS technicians (
  id SERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  full_name TEXT,                      -- NEW FIELD
  email TEXT,
  language TEXT,
  category TEXT,
  area TEXT,
  expertise TEXT,
  vehicle TEXT,
  experience TEXT,
  push_token TEXT,
  is_online BOOLEAN DEFAULT false, 
  documents JSONB DEFAULT '{}'::jsonb, -- NEW FIELD (ALL DOCS STORED HERE)
  is_verified BOOLEAN DEFAULT false,
  is_approved BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
