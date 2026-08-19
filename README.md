# Team Snek — Development & Deployment Guide

This project runs on **Firebase Functions** and uses **Google Cloud Tasks** for background jobs.  
The source code is deployment agnostic: **there is no default region anywhere
in the repo**. Every deployment sets `VITE_FIREBASE_FUNCTIONS_REGION`
explicitly, as an ordinary environment variable — a Replit Secret, a CI
variable, an `export` in your shell. There are no config files to create: the
frontend build (Vite) and the functions build both read it from the
environment. It must match that project's Firestore region. Anything
region-dependent throws or fails fast when it is unset.
As a fact about one specific deployment: production runs on the
**`team-snek`** project, with Firestore and all Cloud Functions in
`australia-southeast1` (Sydney).

> TL;DR: provision a project with `scripts/bootstrap-gcp-project.sh
> <PROJECT_ID> <REGION>`, put the frontend env it prints into `frontend/.env`
> (or Replit Secrets), then deploy with `npm run deploy`.

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

All configuration is read from **ordinary environment variables** — Replit
Secrets, CI variables, an `export` in your shell — so a fresh workspace needs
no files. The frontend additionally accepts a local `frontend/.env` because
Vite reads one and it is convenient for local work; the functions codebase
reads no files at all. Keep the two workspaces' variables separate so server
secrets never reach the browser bundle.

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

The frontend is entirely env-driven. There are no fallback values -- a missing
variable throws at import time rather than silently connecting to the wrong
project:

```ts
// frontend/src/firebaseConfig.ts
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// Region must match functions/src/config/region.ts or callables 404.
export const functions = getFunctions(app, functionsRegion)
```

`scripts/bootstrap-gcp-project.sh` prints all of these for a newly provisioned
project.

> 🔐 Never commit real `.env` files.

### 1.2 Functions (environment only — no files)

Functions config is **environment variables, nothing else**. Set the region in
the same place as every other deployment secret and deploy:

```bash
export VITE_FIREBASE_FUNCTIONS_REGION=<region>   # must match that project's Firestore region
bash scripts/deploy.sh functions
```

There is no default and no config file: `functions/src/config/region.ts` throws
at module load if the value is missing, and `scripts/deploy.sh` refuses to run
without it.

How the value gets from your shell into the deployed functions is worth
knowing, because it is not obvious. firebase-tools does not pass the ambient
environment to the processes it spawns — function discovery, the emulated
runtime and the deployed runtime each get an environment it constructs itself
(`FIREBASE_CONFIG`, `GCLOUD_PROJECT`, `GOOGLE_CLOUD_QUOTA_PROJECT`, `PORT`,
`FUNCTIONS_CONTROL_API`, `HOME`, `PATH`), and `.env` files reach only the
deployed runtime, never discovery. The functions **build** does run in your
shell, though (it is the `predeploy` hook), so that is where the environment is
read: `functions/tools/build-entry.mjs` stamps the config into the generated
entrypoint `functions/lib/entry.js`, exactly as Vite bakes `VITE_` vars into
the frontend bundle. A real environment variable always wins over the stamp.

### 1.3 (Optional) Root Shared Env

If you want a single source of truth for shared constants:

**`./.env.shared.example`**

```env
PROJECT_ID=
REGION=        # REQUIRED: must match the project's Firestore region
```

You can load this in scripts and write into both sub-envs if desired. This is **optional** and not required by the app.

---

## 🔑 2) Firebase Project Aliases (`.firebaserc`)

`.firebaserc` stores project aliases for Firebase CLI and **is committed** to git.

**Example `.firebaserc`**

```json
{
  "projects": {
    "production": "team-snek",
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
firebase use mine         # your project
firebase use production   # team-snek (australia-southeast1)
```

Note there is deliberately no `default` alias, so a bare `firebase deploy` in
this repo cannot silently reach production. `scripts/deploy.sh` always passes
`--project` explicitly.

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
Replace `<YOUR_PROJECT_ID>` with your project ID (e.g., `team-snek`).

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

Use your project's region family (must pair with the queue location below,
which in turn must match the Firestore region — see the note above):

```bash
gcloud app create --region=<REGION_FAMILY>
```

### 4.4 Create the Cloud Tasks queue

Use the configured region (the same value as `VITE_FIREBASE_FUNCTIONS_REGION`;
it must match the project's Firestore region):

```bash
gcloud tasks queues create turn-expirations --location=<REGION>
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
gcloud tasks queues describe turn-expirations --location=<REGION>

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
  Run `gcloud app create --region=<REGION_FAMILY>` first, then create your queue.

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

# Create App Engine (region family must pair with the queue location)
gcloud app create --region=<REGION_FAMILY>

# Create queue (the configured region; must match the Firestore region)
gcloud tasks queues create turn-expirations --location=<REGION>

# IAM roles
PROJECT_ID=<YOUR_PROJECT_ID>
SA_EMAIL="${PROJECT_ID}@appspot.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/cloudtasks.enqueuer"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/cloudfunctions.invoker"
```

---

Happy building! 🎯
