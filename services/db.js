// services/db.js

import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

// ==================== VALIDATE ENV ====================
const required = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "DATABASE_URL",
];

const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error("❌ Missing required environment variables:");
  missing.forEach((key) => console.error(`   - ${key}`));
  console.error("\n   Please check your .env file");
  process.exit(1);
}

// ==================== SUPABASE CLIENT ====================
// Used for auth verification, storage, realtime
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// ==================== POSTGRES POOL ====================
// Used for all direct SQL queries in routes
// Port 6543 = Transaction Pooler (PgBouncer) - good for APIs
// Port 5432 = Direct connection - good for migrations
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Supabase pooler
  },
  max: 10,                    // Max connections (pooler handles the rest)
  min: 1,                     // Keep at least 1 alive
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 10000, // Fail after 10s if can't connect
  allowExitOnIdle: false,     // Keep pool alive
});

// ==================== POOL EVENTS ====================
pool.on("connect", (client) => {
  // Set Indian timezone for every new connection
  client.query("SET timezone = 'Asia/Kolkata'").catch(() => {});
});

pool.on("error", (err) => {
  // Log but don't crash - pool auto-reconnects
  console.error("⚠️  PostgreSQL pool error:", err.message);
});

// ==================== TEST CONNECTIONS ====================
export const testConnections = async () => {
  let pgOk = false;
  let supabaseOk = false;

  // ---- PostgreSQL ----
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await pool.query(
        `SELECT 
          NOW() as time, 
          current_database() as db, 
          current_user as usr`
      );
      const { db, usr, time } = result.rows[0];
      console.log("✅ PostgreSQL connected");
      console.log(`   DB   : ${db}`);
      console.log(`   User : ${usr}`);
      console.log(`   Time : ${new Date(time).toLocaleString("en-IN")}`);
      pgOk = true;
      break;
    } catch (err) {
      console.error(
        `❌ PostgreSQL attempt ${attempt}/${maxRetries}: ${err.message}`
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  if (!pgOk) {
    console.error("❌ PostgreSQL: All connection attempts failed");
    console.error("   Hint: Check DATABASE_URL in .env");
    // Don't exit - allow server to start, DB errors will show per-request
  }

  // ---- Supabase ----
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id")
      .limit(1);

    // PGRST116 = no rows (table empty) - that's fine
    // 42P01 = table doesn't exist - also fine at this point
    if (error && !["PGRST116", "42P01"].includes(error.code)) {
      console.error("❌ Supabase error:", error.message, `(code: ${error.code})`);
    } else {
      console.log("✅ Supabase connected");
      supabaseOk = true;
    }
  } catch (err) {
    console.error("❌ Supabase connection error:", err.message);
  }

  return { pgOk, supabaseOk };
};

// ==================== GRACEFUL SHUTDOWN ====================
export const closePool = async () => {
  try {
    await pool.end();
    console.log("✅ PostgreSQL pool closed");
  } catch (err) {
    console.error("Error closing pool:", err.message);
  }
};

export default supabase;