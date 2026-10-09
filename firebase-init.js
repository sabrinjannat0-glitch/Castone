// ============================================================
// This file connects your app to YOUR Firebase project.
// We load Firebase straight from Google's CDN (no npm needed),
// which works fine for a project this size.
// ============================================================

// Import the pieces we need: the core app, Firestore (database),
// and Auth (login/signup).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";

// Your project's config, copied from the Firebase console.
const firebaseConfig = {
  apiKey: "AIzaSyAUssxS1O_UCtdDTwj516OdKx4aQrQXbtM",
  authDomain: "onboarding-checklist-98f44.firebaseapp.com",
  projectId: "onboarding-checklist-98f44",
  storageBucket: "onboarding-checklist-98f44.firebasestorage.app",
  messagingSenderId: "697890323443",
  appId: "1:697890323443:web:ca8acc42a637b894343086",
};

// Start up Firebase with that config.
const app = initializeApp(firebaseConfig);

// Create the two connections the rest of our app will use:
// db    -> talk to Firestore (save/load checklist data)
// auth  -> talk to Authentication (login/signup)
export const db = getFirestore(app);
export const auth = getAuth(app);
