import express from "express";
import { pool } from "../services/db.js";

const router = express.Router();

router.post("/save-token", async (req, res) => {
  const { push_token, technician_id } = req.body;

  if (!technician_id) {
    return res.status(400).json({ error: "technician_id is required" });
  }

  try {
    const technicianCheck = await pool.query(
      `SELECT id FROM technicians WHERE id = $1 LIMIT 1`,
      [technician_id]
    );

    if (technicianCheck.rowCount === 0) {
      return res.status(404).json({ error: "Technician not found" });
    }

    if (push_token) {
      await pool.query(
        `UPDATE technicians
         SET push_token = NULL
         WHERE push_token = $1 AND id <> $2`,
        [push_token, technician_id]
      );
    }

    await pool.query(
      `UPDATE technicians
       SET push_token = $1
       WHERE id = $2`,
      [push_token || null, technician_id]
    );

    return res.json({
      success: true,
      technician_id,
      has_token: !!push_token,
    });
  } catch (err) {
    console.error("SAVE TOKEN ERROR:", err);
    return res.status(500).json({ error: "Failed to save token" });
  }
});

export default router;