// firebaseConfig.js
import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAIEv-MIsJK6Vf2eov9icrahXbD13tTD-A",
  authDomain: "motors-1be96.firebaseapp.com",
  projectId: "motors-1be96",
  storageBucket: "motors-1be96.appspot.com",
  messagingSenderId: "260215310644",
  appId: "1:260215310644:android:cb86192e55a7cb22f0bd61"
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

export const auth = getAuth(app);
export const db = getFirestore(app);
