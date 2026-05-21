import express from "express";
import { pool } from "../services/db.js";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

/* list leads */
router.get("/", async (_, res) => {
  try {
    const data = await pool.query(
      "SELECT * FROM leads ORDER BY created_at DESC"
    );
    res.json(data.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* create lead */
router.post("/", async (req, res) => {
  try {
    const { name, phone, city, vehicle, pkg, price } = req.body;

    const id = "L-" + uuidv4().slice(0, 6);

    const result = await pool.query(
      `INSERT INTO leads (id, name, phone, city, vehicle, pkg, price)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [id, name, phone, city, vehicle, pkg, price]
    );

    res.json(result.rows[0]);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
