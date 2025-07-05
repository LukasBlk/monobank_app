// src/firebaseConfig.js
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyDWON50mEWXzm1k5ILUpk2Ppm3xIVM2jPw",
  authDomain: "monobank-app.firebaseapp.com",
  projectId: "monobank-app",
  storageBucket: "monobank-app.firebasestorage.app",
  messagingSenderId: "333232245762",
  appId: "1:333232245762:web:2c770476cf2028bbcf6b1b",
  measurementId: "G-14VPBDE9DB"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

export const firebaseApp = initializeApp(firebaseConfig);