// services/firebaseAdmin.js
import admin from "firebase-admin";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!raw) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT env variable is missing!");
  process.exit(1);
}

try {
  const serviceAccount = JSON.parse(raw);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase Admin initialized");
  }
} catch (err) {
  console.error("❌ Firebase JSON parse failed:", err.message);
  process.exit(1);
}

export default admin;