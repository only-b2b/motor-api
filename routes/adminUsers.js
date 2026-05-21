// routes/adminUsers.js
import express from "express";
import admin from "../services/firebaseAdmin.js";

const router = express.Router();

// ❌ REMOVED: const db = admin.firestore(); (was running at import time)

router.get("/users", async (req, res) => {
  try {
    // ✅ Call firestore() inside the route handler instead
    const db = admin.firestore();
    const snapshot = await db.collection("users").get();

    const users = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ success: true, users });
  } catch (error) {
    console.error("Firestore fetch error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;