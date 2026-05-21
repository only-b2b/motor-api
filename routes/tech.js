// routes/tech.js
import express from "express";
import { pool } from "../services/db.js";

const router = express.Router();

/* -------------------------------------------------------
   LOGIN (Technician login by phone)
------------------------------------------------------- */
router.post("/login", async (req, res) => {
  const { phone } = req.body;

  try {
    const tech = await pool.query(
      "SELECT * FROM technicians WHERE phone = $1",
      [phone]
    );

    if (tech.rows.length === 0) {
      return res.json({ exists: false });
    }

    return res.json({ exists: true, tech: tech.rows[0] });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* -------------------------------------------------------
   REGISTER TECHNICIAN
------------------------------------------------------- */
router.post("/register", async (req, res) => {
  const {
    phone,
    email,
    language,
    category,
    area,
    expertise,
    vehicle,
    experience,
    fullName,
  } = req.body;

  try {
    // Check if phone already exists
    const existing = await pool.query(
      "SELECT * FROM technicians WHERE phone = $1",
      [phone]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: "PHONE_EXISTS",
        tech: existing.rows[0],
      });
    }

    // Insert new technician
    const result = await pool.query(
      `
      INSERT INTO technicians 
        (phone, email, language, category, area, expertise, vehicle, experience, full_name, documents)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb)
      RETURNING *
      `,
      [
        phone,
        email,
        language,
        category,
        area,
        expertise,
        vehicle,
        experience,
        fullName,
      ]
    );

    return res.json({ success: true, tech: result.rows[0] });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(400).json({ success: false, error: err.message });
  }
});

/* -------------------------------------------------------
   UPDATE DOCUMENT_URL (thumbnail only)
------------------------------------------------------- */
router.post("/update-doc", async (req, res) => {
  const { technician_id, document_url } = req.body;

  try {
    const result = await pool.query(
      `
      UPDATE technicians
      SET document_url = $1
      WHERE id = $2
      RETURNING *
      `,
      [document_url, technician_id]
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "TECHNICIAN_NOT_FOUND" });
    }

    return res.json({ success: true, tech: result.rows[0] });
  } catch (err) {
    console.error("Update Doc URL error:", err);
    return res.status(400).json({ success: false, error: err.message });
  }
});

/* -------------------------------------------------------
   GET ALL TECHNICIANS (for Admin Panel)
   GET /tech/all
------------------------------------------------------- */
router.get("/all", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM technicians ORDER BY id DESC"
    );

    return res.json({
      success: true,
      technicians: result.rows,
    });
  } catch (err) {
    console.error("Fetch technicians error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// routes/tech.js
router.post("/save-fcm-token", async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: "Token missing" });
  }

  await pool.query(
    "UPDATE technicians SET fcm_token=$1 WHERE id=$2",
    [token, req.user.id] // or tech id from auth
  );

  res.json({ success: true });
});

router.post("/save-expo-token", async (req, res) => {
  const { technician_id, token } = req.body;

  if (!technician_id || !token) {
    return res.status(400).json({ error: "Missing data" });
  }

  await pool.query(
    "UPDATE technicians SET expo_token=$1 WHERE id=$2",
    [token, technician_id]
  );

  res.json({ success: true });
});

export default router;
