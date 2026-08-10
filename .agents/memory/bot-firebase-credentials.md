---
name: Bot Firebase credentials
description: Security and UX constraints for direct-Firebase bot API keys
---

Firebase bot API keys are write-only credentials: the backend stores only a SHA-256 hash and returns plaintext only when an owner creates or rotates a key. The UI must therefore offer copy-once handling and describe regeneration as revocation of the previous key.

**Why:** Recoverable API keys would require storing a secret readable by a client, defeating the credential model used by the bot custom-token exchange.

**How to apply:** Treat a configured credential as a boolean status only. Show the plaintext in transient UI state after successful creation/rotation, provide clipboard/manual-copy support, and never add a Firestore read path for the secret.