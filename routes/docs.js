import express from "express";
import multer from "multer";
import { pool } from "../services/db.js";

const router = express.Router();

/* -------------------------------------------------------
   MULTER STORAGE
------------------------------------------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = file.originalname.split(".").pop();
    cb(null, `${unique}.${ext}`);
  },
});

const upload = multer({ storage });

/* -------------------------------------------------------
   UPLOAD DOCUMENT (file + doc_number)
------------------------------------------------------- */
router.post("/upload", upload.single("file"), async (req, res) => {
  const { technician_id, doc_type, doc_number } = req.body;

  if (!req.file) {
    return res.status(400).json({ success: false, error: "NO_FILE_UPLOADED" });
  }

  const file_url = `/uploads/${req.file.filename}`;

  try {
    /* 1️⃣ Save history in tech_documents */
    await pool.query(
      `
      INSERT INTO tech_documents (technician_id, doc_type, file_url, doc_number)
      VALUES ($1,$2,$3,$4)
      `,
      [technician_id, doc_type, file_url, doc_number || null]
    );

    /* 2️⃣ Save JSON { file: "...", number: "..." } */
    await pool.query(
      `
      UPDATE technicians
      SET documents =
        COALESCE(documents, '{}'::jsonb)
        || jsonb_build_object(
            $1::text,
            jsonb_build_object(
              'file', $2::text,
              'number', $3::text
            )
        )
      WHERE id = $4::int
      `,
      [doc_type, file_url, doc_number || "", technician_id]
    );

    return res.json({
      success: true,
      file_url,
    });
  } catch (err) {
    console.error("Upload Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
