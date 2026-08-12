---
name: Centaur Firebase credentials
description: Security and UX constraints for direct-Firebase centaur API keys
---

Centaur API keys (`ttc_…`) are write-only credentials: the backend stores only a SHA-256 hash in the rules-less `centaurCredentials` collection and returns plaintext only when an owner creates or rotates a key (`createCentaurApiKey`). The UI must therefore offer copy-once handling and describe regeneration as revocation of the previous key.

**Why:** Recoverable API keys would require storing a secret readable by a client, defeating the credential model used by the centaur custom-token exchange (`exchangeCentaurApiKey`).

**How to apply:** Treat a configured credential as a boolean status only (`getCentaurApiKeyStatus`). Show the plaintext in transient UI state after successful creation/rotation, provide clipboard/manual-copy support, and never add a Firestore read path for the secret.

Callable deployment is separate from invocation IAM: an already-deployed callable can return a Google Frontend 403 before its Firebase handler runs when `allUsers` lacks `roles/cloudfunctions.invoker`. A normal Firebase Functions redeploy does not necessarily repair that grant.

**Why:** Callables have been observed deployed and listed by Firebase while remaining blocked at the IAM layer, even as another callable reached its handler normally.

**How to apply:** Grant `roles/cloudfunctions.invoker` to `allUsers` for every browser-called callable in each Firebase project (`scripts/grant-callable-invokers.sh`), then test with an origin-bearing POST. Keep the callable's own Firebase Auth checks for authorization.
