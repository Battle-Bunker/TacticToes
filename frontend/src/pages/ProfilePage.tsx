import React, { useRef, useState } from "react"
import {
  Box,
  Button,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material"
import { signOut } from "firebase/auth"
import { httpsCallable } from "firebase/functions"
import {
  collection,
  deleteDoc,
  doc,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore"
import { useUser } from "../context/UserContext"
import { auth, db, firebaseConfig, functions } from "../firebaseConfig"
import { useFirestoreSubscription } from "../hooks/useFirestoreSubscription"
import { Centaur } from "@shared/types/Game"

const ProfilePage: React.FC = () => {
  const { userID, name } = useUser()

  // ── Centaurs subscription ──────────────────────────────────────────────
  const [centaurs, setCentaurs] = useState<Centaur[]>([])
  useFirestoreSubscription({
    buildTarget: () =>
      userID
        ? query(collection(db, "centaurs"), where("owner", "==", userID))
        : null,
    deps: [userID],
    logLabel: "profile centaurs",
    includeMetadataChanges: false,
    onSnapshot: (snap) => {
      const mapped = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Centaur, "id">),
      }))
      mapped.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      )
      setCentaurs(mapped)
    },
  })

  // ── Add form state ─────────────────────────────────────────────────────
  const [newName, setNewName] = useState("")
  const [addError, setAddError] = useState<string | null>(null)
  const [addBusy, setAddBusy] = useState(false)

  // ── Edit dialog state ──────────────────────────────────────────────────
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingCentaurId, setEditingCentaurId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editPublic, setEditPublic] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editApiKeyConfigured, setEditApiKeyConfigured] = useState(false)
  const [editApiKey, setEditApiKey] = useState<string | null>(null)
  const [editApiKeyBusy, setEditApiKeyBusy] = useState(false)
  const [copiedConfigField, setCopiedConfigField] = useState<string | null>(null)
  const activeEditingCentaurId = useRef<string | null>(null)

  // ── Delete confirmation state ──────────────────────────────────────────
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  // ── Helpers ────────────────────────────────────────────────────────────
  const loadCentaurApiKeyStatus = async (centaurId: string) => {
    try {
      const getStatus = httpsCallable<
        { centaurId: string },
        { centaurId: string; configured: boolean }
      >(functions, "getCentaurApiKeyStatus")
      const result = await getStatus({ centaurId })
      if (activeEditingCentaurId.current === centaurId) {
        setEditApiKeyConfigured(result.data.configured)
      }
    } catch (statusError) {
      console.warn("Unable to check Firebase API key status", statusError)
    }
  }

  const openEditDialog = (centaur: Centaur) => {
    activeEditingCentaurId.current = centaur.id
    setEditingCentaurId(centaur.id)
    setEditName(centaur.name)
    setEditPublic(centaur.public)
    setEditError(null)
    setEditBusy(false)
    setEditApiKeyConfigured(false)
    setEditApiKey(null)
    setCopiedConfigField(null)
    setEditDialogOpen(true)
    void loadCentaurApiKeyStatus(centaur.id)
  }

  const handleCloseEdit = () => {
    activeEditingCentaurId.current = null
    setEditingCentaurId(null)
    setEditDialogOpen(false)
    setEditError(null)
    setEditApiKey(null)
    setCopiedConfigField(null)
  }

  const handleAdd = async () => {
    if (!userID) {
      setAddError("Login required")
      return
    }
    if (!newName.trim()) {
      setAddError("Name required")
      return
    }

    setAddBusy(true)
    setAddError(null)

    const ref = doc(collection(db, "centaurs"))
    const newCentaur: Centaur = {
      id: ref.id,
      name: newName.trim(),
      owner: userID,
      public: false,
      createdAt: serverTimestamp(),
    }

    try {
      await setDoc(ref, newCentaur)
      setNewName("")
      openEditDialog(newCentaur)
    } catch (err) {
      console.error("Failed to add centaur", err)
      setAddError("Failed to add centaur")
    } finally {
      setAddBusy(false)
    }
  }

  const handleGenerateApiKey = async () => {
    if (!editingCentaurId) return

    setEditApiKeyBusy(true)
    setCopiedConfigField(null)
    setEditError(null)

    try {
      const createKey = httpsCallable<
        { centaurId: string },
        { centaurId: string; apiKey: string; rotated: boolean }
      >(functions, "createCentaurApiKey")
      const result = await createKey({ centaurId: editingCentaurId })
      setEditApiKey(result.data.apiKey)
      setEditApiKeyConfigured(true)
    } catch (keyError) {
      console.error("Failed to generate Firebase API key", keyError)
      setEditError("Failed to generate Firebase API key")
    } finally {
      setEditApiKeyBusy(false)
    }
  }

  const handleCopyConfigField = async (fieldName: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedConfigField(fieldName)
    } catch (copyError) {
      console.error(`Failed to copy ${fieldName}`, copyError)
      setEditError(
        `Copy failed for ${fieldName}. Select the value and copy it manually.`,
      )
    }
  }

  const handleSaveEdit = async () => {
    if (!editingCentaurId) return
    if (!editName.trim()) {
      setEditError("Name required")
      return
    }

    setEditBusy(true)
    setEditError(null)

    try {
      await updateDoc(doc(db, "centaurs", editingCentaurId), {
        name: editName.trim(),
        public: editPublic,
      })
      handleCloseEdit()
    } catch (saveError) {
      console.error("Failed to update centaur", saveError)
      setEditError("Failed to save changes")
    } finally {
      setEditBusy(false)
    }
  }

  const handleConfirmDelete = async () => {
    if (editingCentaurId) {
      await deleteDoc(doc(db, "centaurs", editingCentaurId))
    }
    setDeleteDialogOpen(false)
    handleCloseEdit()
  }

  return (
    <Container sx={{ py: 3 }}>
      {/* Profile header */}
      <Box sx={{ mb: 4 }}>
        <Typography variant="h5">{name}</Typography>
        <Button
          size="small"
          sx={{ mt: 1 }}
          onClick={async () => {
            await signOut(auth)
            window.location.reload()
          }}
        >
          Sign out
        </Button>
      </Box>

      {/* Centaurs list */}
      <Box>
        <Typography variant="h5" gutterBottom>
          My Centaurs
        </Typography>
        {centaurs.length === 0 ? (
          <Typography variant="body1" sx={{ mb: 2 }}>
            you got no centaurs m8. add one below.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {centaurs.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell padding="none">
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          p: 1,
                        }}
                      >
                        <Typography>
                          {c.name} {c.public && "(public 👀)"}
                        </Typography>
                        <Button
                          onClick={() => openEditDialog(c)}
                          disabled={addBusy || editBusy}
                          sx={{ minWidth: 0, height: 40 }}
                        >
                          ✏️
                        </Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      {/* Add Centaur form */}
      <Box
        component="form"
        onSubmit={(e) => {
          e.preventDefault()
          handleAdd()
        }}
        sx={{ mt: 4 }}
      >
        <Typography variant="h5" gutterBottom>
          Add a Centaur
        </Typography>

        <TextField
          label="Name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          disabled={addBusy}
          fullWidth
          size="small"
          sx={{ mb: 2 }}
          placeholder="e.g. 'Cool Centaur'"
        />

        <Button
          type="submit"
          variant="contained"
          disabled={addBusy}
          sx={{ mb: 2 }}
        >
          Add Centaur
        </Button>

        {addError && (
          <Typography color="error" variant="body2" sx={{ mb: 2 }}>
            {addError}
          </Typography>
        )}
      </Box>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          sx: { border: "2px solid black", borderRadius: 0, boxShadow: "none" },
        }}
      >
        <DialogTitle>Delete Centaur</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete this centaur?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleConfirmDelete}
            color="error"
            variant="contained"
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Centaur Dialog */}
      <Dialog
        open={editDialogOpen}
        onClose={handleCloseEdit}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          sx: { border: "2px solid black", borderRadius: 0, boxShadow: "none" },
        }}
      >
        <DialogTitle>Edit Centaur</DialogTitle>
        <DialogContent>
          <Box sx={{ mt: 1 }}>
            <TextField
              label="Name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              disabled={editBusy || editApiKeyBusy}
              fullWidth
              size="small"
              sx={{ mb: 2 }}
            />

            <FormControlLabel
              control={
                <Switch
                  checked={editPublic}
                  onChange={(e) => setEditPublic(e.target.checked)}
                  size="small"
                  disabled={editBusy || editApiKeyBusy}
                />
              }
              label="Public"
              sx={{ mb: 2 }}
            />

            <Box
              sx={{
                border: "1px solid",
                borderColor: "divider",
                p: 1.5,
                mb: 2,
              }}
            >
              <Typography variant="subtitle2">
                Firebase centaur connection
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.5, mb: 1 }}>
                {editApiKeyConfigured
                  ? "A Firebase API key is configured. Regenerating it immediately invalidates the previous key."
                  : "Generate a key to let this centaur connect directly to Firebase."}
              </Typography>
              <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleGenerateApiKey}
                  disabled={editBusy || editApiKeyBusy}
                >
                  {editApiKeyBusy
                    ? "Generating..."
                    : editApiKeyConfigured
                      ? "Regenerate Firebase API key"
                      : "Generate Firebase API key"}
                </Button>
              </Box>

              {editApiKey && (
                <>
                  <Typography variant="subtitle2" sx={{ mt: 1.5 }}>
                    Centaur environment configuration
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 0.5, mb: 1 }}>
                    Provide these four values to the centaur process:
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                    sx={{ mb: 1 }}
                  >
                    The centaur API key is the only secret. Copy it now; it
                    cannot be recovered after this dialog closes or after
                    regeneration.
                  </Typography>
                  {[
                    {
                      name: "TACTICTOES_CENTAUR_ID",
                      value: editingCentaurId ?? "",
                      helperText:
                        "The centaur identity used in the Firebase API-key exchange.",
                    },
                    {
                      name: "TACTICTOES_CENTAUR_API_KEY",
                      value: editApiKey,
                      helperText:
                        "Secret. Exchanges for a Firebase custom token scoped to this centaur.",
                    },
                    {
                      name: "TACTICTOES_FIREBASE_PROJECT_ID",
                      value: firebaseConfig.projectId,
                      helperText: "Public Firebase project identifier.",
                    },
                    {
                      name: "TACTICTOES_FIREBASE_API_KEY",
                      value: firebaseConfig.apiKey,
                      helperText:
                        "Public Firebase web-app identifier; not an authentication secret.",
                    },
                  ].map(({ name: fieldName, value, helperText }) => (
                    <Box
                      key={fieldName}
                      sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}
                    >
                      <TextField
                        label={fieldName}
                        value={value}
                        fullWidth
                        size="small"
                        margin="dense"
                        InputProps={{ readOnly: true }}
                        helperText={helperText}
                      />
                      <Button
                        variant="outlined"
                        size="small"
                        onClick={() => handleCopyConfigField(fieldName, value)}
                        sx={{ mt: 1, whiteSpace: "nowrap" }}
                      >
                        {copiedConfigField === fieldName ? "Copied" : "Copy"}
                      </Button>
                    </Box>
                  ))}
                </>
              )}
            </Box>

            {editError && (
              <Typography color="error" variant="body2" sx={{ mb: 2 }}>
                {editError}
              </Typography>
            )}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setDeleteDialogOpen(true)}
            color="error"
            disabled={editBusy || editApiKeyBusy}
            sx={{ mr: "auto" }}
          >
            Delete
          </Button>
          <Button onClick={handleCloseEdit} disabled={editBusy || editApiKeyBusy}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveEdit}
            variant="contained"
            disabled={editBusy || editApiKeyBusy}
          >
            Save Changes
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  )
}

export default ProfilePage
