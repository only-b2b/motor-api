// index.js

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import {
  supabase,
  pool,
  testConnections,
  closePool,
} from "./services/db.js";

import {
  startScheduledOrdersJob,
  startExpiredOrdersJob,
  startScheduledOrdersMonitor,
} from "./services/scheduledOrdersService.js";

// ── Routes ──────────────────────────────────────────────────
import leadsRouter       from "./routes/leads.js";
import techRouter        from "./routes/tech.js";
import docsRouter        from "./routes/docs.js";
import usersRoute        from "./routes/users.js";
import adminUsersRoute   from "./routes/adminUsers.js";
import addressesRoute    from "./routes/addresses.js";
import ordersRoute       from "./routes/orders.js";
import techniciansRouter from "./routes/technicians.js";
import earningsRouter    from "./routes/earnings.js";
import refundsRouter     from "./routes/refunds.js";

// ── Path helpers ─────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Ensure uploads directory exists ──────────────────────────
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log("📁 Created uploads/");
}

// ==================== EXPRESS APP ====================
const app = express();

// ── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use("/uploads", express.static(uploadsDir));

// ── Dev request logger ───────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.use((req, _res, next) => {
    const ts = new Date().toLocaleTimeString("en-IN");
    console.log(`[${ts}] ${req.method} ${req.path}`);
    next();
  });
}

// ==================== ROUTES ====================
app.use("/users",          usersRoute);
app.use("/addresses",      addressesRoute);
app.use("/orders",         ordersRoute);
app.use("/leads",          leadsRouter);
app.use("/tech",           techRouter);
app.use("/docs",           docsRouter);
app.use("/admin",          adminUsersRoute);
app.use("/technicians",    techniciansRouter);
app.use("/api/technician", techniciansRouter);
app.use("/earnings",       earningsRouter);
app.use("/refunds",        refundsRouter);

// ── Health check ─────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok:     true,
      db:     "connected",
      uptime: Math.floor(process.uptime()) + "s",
      ts:     new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ ok: false, db: "error", error: err.message });
  }
});

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error:  "Not found",
    method: req.method,
    path:   req.path,
  });
});

// ── Global error handler ─────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("💥 Unhandled error:", err.message);
  res.status(500).json({
    error:   "Internal server error",
    message: process.env.NODE_ENV === "production"
      ? "Something went wrong"
      : err.message,
  });
});

// ==================== PROCESS EVENTS ====================
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception:", err.message);
  console.error(err.stack);
  process.exit(1);
});

const shutdown = async (sig) => {
  console.log(`\n${sig} → shutting down...`);
  await closePool();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ==================== START ====================
const PORT = parseInt(process.env.PORT || "4000", 10);

const startServer = async () => {
  console.log("\n══════════════════════════════════════");
  console.log("  🚗  Motors API");
  console.log(`  Env  : ${process.env.NODE_ENV || "development"}`);
  console.log(`  Port : ${PORT}`);
  console.log("══════════════════════════════════════\n");

  // Test DB connections
  await testConnections();

  // Start all cron jobs from service file
  startScheduledOrdersJob();
  startExpiredOrdersJob();
  startScheduledOrdersMonitor();
  console.log("⏰ All cron jobs active");

  // Start server
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n✅ Ready → http://localhost:${PORT}`);
    console.log(`   Health → http://localhost:${PORT}/health\n`);
  });
};

startServer().catch((err) => {
  console.error("❌ Startup failed:", err.message);
  process.exit(1);
});