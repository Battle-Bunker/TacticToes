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

// Must match the region the functions are deployed to (see
// functions/src/config/region.ts). A mismatch makes every callable 404.
// No default by design: region is required, per-deployment config.
const regionFromEnv = import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION;
if (!regionFromEnv) {
  throw new Error(
    "VITE_FIREBASE_FUNCTIONS_REGION is required: set it in your Replit " +
    "Secrets or .env file. It must match the region the Cloud Functions are " +
    "deployed to (which in turn must match the project's Firestore region -- " +
    "see functions/src/config/region.ts). There is deliberately no default."
  );
}
export const functionsRegion: string = regionFromEnv;

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
export const functions = getFunctions(app, functionsRegion)
// Nothing imports the Analytics instance, but getAnalytics(app) initializes
// Firebase Analytics collection as a side effect, so the call stays.
getAnalytics(app)
export const auth = getAuth(app)

export const provider = new GoogleAuthProvider()
provider.addScope("profile")
provider.addScope("email")

if (window.location.hostname === "localhost") {
  connectFirestoreEmulator(db, "localhost", 8080)
  connectAuthEmulator(auth, "http://localhost:9099")
  connectFunctionsEmulator(functions, "localhost", 5001)
}
