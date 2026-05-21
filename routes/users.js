// api/routes/users.js

import express from "express";
import { pool } from "../services/db.js";

const router = express.Router();

/* =========================
   USER REGISTRATION
========================= */
router.post("/register", async (req, res) => {
  try {
    const { uid, name, email, phone } = req.body;

    if (!uid || !phone) {
      return res.status(400).json({ error: "Missing required fields (uid, phone)" });
    }

    const exists = await pool.query(
      `SELECT id FROM users WHERE firebase_uid=$1 OR phone=$2`,
      [uid, phone]
    );

    if (exists.rows.length > 0) {
      return res.status(409).json({ error: "User already exists" });
    }

    await pool.query(
      `INSERT INTO users (firebase_uid, name, email, phone)
       VALUES ($1,$2,$3,$4)`,
      [uid, name || null, email || null, phone]
    );

    res.status(201).json({ success: true });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Database error" });
  }
});

/* =========================
   SAVE PUSH TOKEN (FCM)
   Called from customer app after login
========================= */
router.post("/save-token", async (req, res) => {
  try {
    const { firebase_uid, push_token } = req.body;

    if (!firebase_uid) {
      return res.status(400).json({ error: "firebase_uid required" });
    }

    // Remove token from any other user first (prevent duplicate tokens)
    if (push_token) {
      await pool.query(
        `UPDATE users SET push_token = NULL
         WHERE push_token = $1 AND firebase_uid != $2`,
        [push_token, firebase_uid]
      );
    }

    await pool.query(
      `UPDATE users
       SET push_token = $1,
           updated_at = NOW()
       WHERE firebase_uid = $2`,
      [push_token || null, firebase_uid]
    );

    console.log(`✅ User push token saved: ${firebase_uid} | has_token: ${!!push_token}`);
    res.json({ success: true, has_token: !!push_token });
  } catch (err) {
    console.error("USER SAVE TOKEN ERROR:", err);
    res.status(500).json({ error: "Failed to save token" });
  }
});

/* =========================
   GET USER PROFILE
========================= */
router.get("/:uid", async (req, res) => {
  try {
    const { uid } = req.params;
    const result = await pool.query(
      `SELECT id, firebase_uid, name, email, phone, created_at
       FROM users WHERE firebase_uid = $1`,
      [uid]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET USER ERROR:", err);
    res.status(500).json({ error: "Failed to get user" });
  }
});

/* =========================
   GET SAVED PLACES
========================= */
router.get("/:uid/saved-places", async (req, res) => {
  try {
    const { uid } = req.params;

    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (!userRes.rows.length) return res.json([]);

    const userId = userRes.rows[0].id;

    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'saved_places'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT id, name, address, lat, lng, type, created_at
       FROM saved_places
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json(result.rows || []);
  } catch (error) {
    console.error("Saved places error:", error);
    res.status(500).json({ error: "Failed to load saved places" });
  }
});

/* =========================
   ADD SAVED PLACE
========================= */
router.post("/:uid/saved-places", async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, address, lat, lng, type = "other" } = req.body;

    if (!name || !address || !lat || !lng) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userRes.rows[0].id;

    const result = await pool.query(
      `INSERT INTO saved_places (user_id, name, address, lat, lng, type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, name, address, lat, lng, type]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Add saved place error:", error);
    res.status(500).json({ error: "Failed to add saved place" });
  }
});

/* =========================
   DELETE SAVED PLACE
========================= */
router.delete("/:uid/saved-places/:placeId", async (req, res) => {
  try {
    const { uid, placeId } = req.params;

    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [uid]
    );

    if (!userRes.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const userId = userRes.rows[0].id;

    const result = await pool.query(
      "DELETE FROM saved_places WHERE id = $1 AND user_id = $2 RETURNING id",
      [placeId, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Saved place not found" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Delete saved place error:", error);
    res.status(500).json({ error: "Failed to delete saved place" });
  }
});

export default router;