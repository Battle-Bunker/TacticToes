import { initializeApp } from "firebase/app"
import { getAnalytics } from "firebase/analytics"
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore"
import { connectAuthEmulator, getAuth, GoogleAuthProvider } from "firebase/auth"
import { getFunctions, connectFunctionsEmulator } from "firebase/functions"

const requiredEnvVars = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

const missingVars = requiredEnvVars.filter(
  (key) => !import.meta.env[key]
);

if (missingVars.length > 0) {
  throw new Error(
    `Missing required Firebase environment variables:\n` +
    `  ${missingVars.join('\n  ')}\n\n` +
    `Please set these in your Replit Secrets or .env file.\n` +
    `You can find these values in the Firebase Console under Project Settings > General > Your Apps.`
  );
}

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
export const functions = getFunctions(app)
export const analytics = getAnalytics(app)
export const auth = getAuth(app)

export const provider = new GoogleAuthProvider()
provider.addScope("profile")
provider.addScope("email")

if (window.location.hostname === "localhost") {
  connectFirestoreEmulator(db, "localhost", 8080)
  connectAuthEmulator(auth, "http://localhost:9099")
  connectFunctionsEmulator(functions, "localhost", 5001)
}
