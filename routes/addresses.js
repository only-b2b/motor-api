// api/routes/addresses.js

import express from "express";
import { pool } from "../services/db.js";

const router = express.Router();

// ─────────────────────────────────────────────
// GET all addresses for a user
// ─────────────────────────────────────────────
router.get("/:firebase_uid", async (req, res) => {
  try {
    const { firebase_uid } = req.params;

    if (!firebase_uid) {
      return res.status(400).json({ error: "firebase_uid required" });
    }

    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [firebase_uid]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const addresses = await pool.query(
      `SELECT *
       FROM user_addresses
       WHERE user_id = $1
       ORDER BY
         is_default DESC,
         last_used_at DESC NULLS LAST,
         created_at DESC`,
      [userRes.rows[0].id]
    );

    res.json(addresses.rows);
  } catch (err) {
    console.error("GET ADDRESSES ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// ADD new address
// ─────────────────────────────────────────────
// api/routes/addresses.js - Add better error logging

router.post("/", async (req, res) => {
  try {
    const { firebase_uid, label, address, city, latitude, longitude } = req.body;

    console.log("📍 Save address request:", { firebase_uid, address, city }); // ← add this

    if (!firebase_uid || !address?.trim() || !city?.trim()) {
      console.log("❌ Missing fields:", { firebase_uid, address, city });
      return res.status(400).json({ 
        error: "Missing required fields",
        received: { firebase_uid: !!firebase_uid, address: !!address, city: !!city }
      });
    }

    const userRes = await pool.query(
      "SELECT id FROM users WHERE firebase_uid = $1",
      [firebase_uid]
    );

    console.log("👤 User lookup result:", userRes.rows); // ← add this

    if (userRes.rows.length === 0) {
      return res.status(404).json({ 
        error: "User not found",
        firebase_uid // ← return uid so you can debug
      });
    }

    const userId = userRes.rows[0].id;

    await pool.query(
      `UPDATE user_addresses SET is_default = FALSE WHERE user_id = $1`,
      [userId]
    );

    const result = await pool.query(
      `INSERT INTO user_addresses
       (user_id, label, address, city, latitude, longitude, is_default, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,NOW())
       RETURNING *`,
      [
        userId,
        label || "Home",
        address.trim(),
        city.trim(),
        latitude ?? null,
        longitude ?? null,
      ]
    );

    console.log("✅ Address saved:", result.rows[0]); // ← add this
    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error("❌ ADD ADDRESS ERROR:", err);
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

// ─────────────────────────────────────────────
// ✅ Fix 5: /default MUST come BEFORE /:id
// Otherwise Express matches "default" as an id
// ─────────────────────────────────────────────
router.put("/:address_id/default", async (req, res) => {
  try {
    const { address_id } = req.params;

    const addrRes = await pool.query(
      "SELECT user_id FROM user_addresses WHERE id = $1",
      [address_id]
    );

    if (addrRes.rows.length === 0) {
      return res.status(404).json({ error: "Address not found" });
    }

    const userId = addrRes.rows[0].user_id;

    // Remove default from all user addresses
    await pool.query(
      `UPDATE user_addresses SET is_default = FALSE WHERE user_id = $1`,
      [userId]
    );

    // Set this one as default + update last_used_at
    const updated = await pool.query(
      `UPDATE user_addresses
       SET is_default = TRUE, last_used_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [address_id]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error("SET DEFAULT ADDRESS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// UPDATE address by id
// ─────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { label, address, city } = req.body;

    if (!label || !address || !city) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const updated = await pool.query(
      `UPDATE user_addresses
       SET label=$1, address=$2, city=$3
       WHERE id=$4
       RETURNING *`,
      [label, address, city, id]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: "Address not found" });
    }

    res.json(updated.rows[0]);
  } catch (err) {
    console.error("UPDATE ADDRESS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────
// DELETE address
// ─────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      "DELETE FROM user_addresses WHERE id=$1 RETURNING id",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Address not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE ADDRESS ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;