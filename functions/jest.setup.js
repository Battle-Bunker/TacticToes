// Region is required config with no default (functions/src/config/region.ts
// throws at module load without it). Tests never deploy or call anything
// region-addressed, so a dummy satisfies the load-time check without
// weakening the throw. Respect an explicitly set value.
process.env.VITE_FIREBASE_FUNCTIONS_REGION =
  process.env.VITE_FIREBASE_FUNCTIONS_REGION || "test-region-1"
