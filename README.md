# Tactic Toes — Development & Deployment Guide

This project runs on **Firebase Functions** and uses **Google Cloud Tasks** for background jobs.  
It is configured to support both:

- A **default shared project** (`tactic-toes`)
- Your **own Firebase/GCP project** (BYO project, e.g., `tactic-toes-tuke`)

> TL;DR: Put your frontend env in `frontend/.env`, your server env in `functions/.env`, add your Firebase project alias via `firebase use --add`, then run the `gcloud` commands below once per project.

---

## 📦 Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Firebase CLI](https://firebase.google.com/docs/cli)
  ```bash
  npm i -g firebase-tools
  firebase login
  ```
- [Google Cloud SDK (gcloud)](https://cloud.google.com/sdk/docs/install)
  ```bash
  gcloud init
  gcloud auth login
  ```
- A Firebase project (create at [Firebase Console](https://console.firebase.google.com/))

---

## ⚙️ 1) Environment Variables

We keep env files **separate** per workspace to avoid leaking server secrets into the browser and to match tooling expectations.

### 1.1 Frontend (`/frontend/.env`)

1. Copy the template and fill your Firebase Web App config:

```bash
cp frontend/.env.example frontend/.env
```

**`frontend/.env.example`**

```env
# Public Firebase SDK config for the Web app (Vite requires VITE_* prefix)
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_MEASUREMENT_ID=
```

The frontend loads from env first, then falls back to the defaults:

```ts
// frontend/src/firebaseConfig.ts
export const firebaseConfig = {
  apiKey:
    import.meta.env.VITE_FIREBASE_API_KEY ||
    "AIzaSyB8_kTX7I3_VlMhfTvhsCvkFKZFQH8wySg",
  authDomain:
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "tactic-toes.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "tactic-toes",
  storageBucket:
    import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "tactic-toes.appspot.com",
  messagingSenderId:
    import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "609730573184",
  appId:
    import.meta.env.VITE_FIREBASE_APP_ID ||
    "1:609730573184:web:93cc2deb12fa0e22a34765",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-WYJM1LMD06",
};
```

> 🔐 Never commit real `.env` files.

### 1.2 Functions (`/functions/.env`)

1. Copy the template and fill your values:

```bash
cp functions/.env.example functions/.env
```

**`functions/.env.example`**

```env
# Cloud Tasks / Backend settings
TASKS_PROJECT_ID=        # e.g. tactic-toes-tuke
TASKS_LOCATION=us-central1
TASKS_QUEUE=turn-expirations
```

Your Functions code should read these and **fallback** to defaults if unset:

- `TASKS_PROJECT_ID` → defaults to the runtime project (e.g., `process.env.GCLOUD_PROJECT`)
- `TASKS_LOCATION` → default `us-central1`
- `TASKS_QUEUE` → default `turn-expirations`

> Keep server secrets here or use `firebase functions:config:set` (not shown here).

### 1.3 (Optional) Root Shared Env

If you want a single source of truth for shared constants:

**`./.env.shared.example`**

```env
PROJECT_ID=
REGION=us-central1
```

You can load this in scripts and write into both sub-envs if desired. This is **optional** and not required by the app.

---

## 🔑 2) Firebase Project Aliases (`.firebaserc`)

`.firebaserc` stores project aliases for Firebase CLI and **is committed** to git.

**Example `.firebaserc`**

```json
{
  "projects": {
    "default": "tactic-toes",
    "tuke": "tactic-toes-tuke",
    "mine": "yourproject-id"
  }
}
```

Add your own project alias (this **updates `.firebaserc` automatically**):

```bash
firebase use --add
# select your project from the list
# enter an alias, e.g. "mine"
```

Switch between projects:

```bash
firebase use mine      # your project
firebase use default   # shared default (tactic-toes)
```

---

## 🛠 3) Local Development

### Start Firebase emulators

```bash
firebase emulators:start
```

### Start the frontend

```bash
cd frontend
npm install
npm run dev
```

### Build Functions (manual step)

The Functions emulator **does not** auto-rebuild TypeScript:

```bash
cd functions
npm install
npm run build
```

> If code changes don’t show, run `npm run build` again.

---

## ☁️ 4) Google Cloud Setup (per project)

Run these **once** per Firebase/GCP project you plan to use.  
Replace `<YOUR_PROJECT_ID>` with your project ID (e.g., `tactic-toes-tuke`).

> **Important**: Cloud Tasks requires an App Engine app in the **same region family** as your queue (e.g., AE in `us-central`, queue in `us-central1`).

### 4.1 Select the project

```bash
gcloud config set project <YOUR_PROJECT_ID>
```

### 4.2 Enable required APIs

```bash
gcloud services enable   cloudtasks.googleapis.com   appengine.googleapis.com   cloudfunctions.googleapis.com   firestore.googleapis.com   iam.googleapis.com
```

### 4.3 Create App Engine app (if not already created)

```bash
gcloud app create --region=us-central
```

### 4.4 Create the Cloud Tasks queue

```bash
gcloud tasks queues create turn-expirations --location=us-central1
```

### 4.5 Grant IAM roles to the calling Service Account

Most setups use the **App Engine default service account**:

```
<YOUR_PROJECT_ID>@appspot.gserviceaccount.com
```

Grant the required roles:

```bash
PROJECT_ID=<YOUR_PROJECT_ID>
SA_EMAIL="${PROJECT_ID}@appspot.gserviceaccount.com"

# Allow enqueuing tasks
gcloud projects add-iam-policy-binding "$PROJECT_ID"   --member="serviceAccount:${SA_EMAIL}"   --role="roles/cloudtasks.enqueuer"

# Firestore/Datastore access (choose one that matches your DB usage)
gcloud projects add-iam-policy-binding "$PROJECT_ID"   --member="serviceAccount:${SA_EMAIL}"   --role="roles/datastore.user"
# OR:
#gcloud projects add-iam-policy-binding "$PROJECT_ID" #  --member="serviceAccount:${SA_EMAIL}" #  --role="roles/firestore.user"

# If Cloud Tasks call your HTTP Cloud Function:
gcloud projects add-iam-policy-binding "$PROJECT_ID"   --member="serviceAccount:${SA_EMAIL}"   --role="roles/cloudfunctions.invoker"
```

> If you use a different caller (e.g., Cloud Run SA), grant these roles to that SA instead.

---

## ✅ 5) Sanity Checks

```bash
# Active project?
gcloud config get-value project

# App Engine app exists?
gcloud app describe

# Queue exists?
gcloud tasks queues describe turn-expirations --location=us-central1

# IAM check for the SA
PROJECT_ID=<YOUR_PROJECT_ID>
gcloud projects get-iam-policy "$PROJECT_ID"   --flatten="bindings[].members"   --format="table(bindings.role, bindings.members)"   --filter="bindings.members:serviceAccount:${PROJECT_ID}@appspot.gserviceaccount.com"
```

---

## 🚀 6) Deployment

Pick your alias first:

```bash
firebase use mine   # or "tuke" / "default"
```

Deploy functions:

```bash
firebase deploy --only functions
```

(Or deploy everything:)

```bash
firebase deploy
```

---

## 📝 Troubleshooting

- **Functions don’t reload in emulator**  
  Run `npm run build` in `/functions` after changes.

- **`FAILED_PRECONDITION: App Engine app does not exist`**  
  Run `gcloud app create --region=us-central` first, then create your queue.

- **`PERMISSION_DENIED` when enqueueing tasks**  
  Ensure the caller SA has `roles/cloudtasks.enqueuer`.  
  If Tasks invoke an HTTP function, also grant `roles/cloudfunctions.invoker`.

- **Region mismatch**  
  App Engine region family must match the Cloud Tasks queue location (e.g., `us-central` ↔ `us-central1`).

---

## 🔐 Security Notes

- Do **not** commit real `.env` files or service account keys.
- Frontend env values are **public** by design (browser-exposed). Keep secrets in server env or Firebase Functions config.
- Prefer Workload Identity / default credentials on GCP instead of JSON key files whenever possible.

---

## 📋 Quick Commands Recap

```bash
# Select project
gcloud config set project <YOUR_PROJECT_ID>

# Enable APIs
gcloud services enable cloudtasks.googleapis.com appengine.googleapis.com cloudfunctions.googleapis.com firestore.googleapis.com iam.googleapis.com

# Create App Engine (us-central)
gcloud app create --region=us-central

# Create queue (us-central1)
gcloud tasks queues create turn-expirations --location=us-central1

# IAM roles
PROJECT_ID=<YOUR_PROJECT_ID>
SA_EMAIL="${PROJECT_ID}@appspot.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/cloudtasks.enqueuer"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/cloudfunctions.invoker"
```

---

Happy building! 🎯
