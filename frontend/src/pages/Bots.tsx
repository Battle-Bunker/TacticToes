// Bots.tsx

import React, { useEffect, useState } from "react";
import {
  Box,
  Button,
  Container,
  TextField,
  Typography,
  FormGroup,
  FormControlLabel,
  Checkbox,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { Refresh } from "@mui/icons-material";
import { Hue } from "@uiw/react-color";
import { useUser } from "../context/UserContext";
import { db } from "../firebaseConfig";
import { generateColor } from "../utils/colourUtils";
import { emojiList } from "@shared/types/Emojis";
import { Bot, GameType } from "@shared/types/Game";
import {
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  collection,
  query,
  where,
  onSnapshot,
} from "firebase/firestore";

const availableGameTypes: GameType[] = [
  "connect4",
  "longboi",
  "tactictoes",
  "snek",
  "colourclash",
  "reversi",
  "teamsnek",
  "kingsnek",
];

const Bots: React.FC = () => {
  const { userID } = useUser();
  const theme = useTheme();

  // — My Bots subscription —
  const [bots, setBots] = useState<Bot[]>([]);
  useEffect(() => {
    if (!userID) return;
    const q = query(collection(db, "bots"), where("owner", "==", userID));
    return onSnapshot(q, (snap) => {
      setBots(
        snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Bot, "id">) })),
      );
    });
  }, [userID]);

  // existing delete function
  const deleteBot = async (id: string) => {
    await deleteDoc(doc(db, "bots", id));
  };

  // deletion dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const openDeleteDialog = (id: string) => {
    setPendingDeleteId(id);
    setDeleteDialogOpen(true);
  };

  const handleCancelDelete = () => {
    setPendingDeleteId(null);
    setDeleteDialogOpen(false);
  };

  const handleConfirmDelete = async () => {
    if (pendingDeleteId) {
      await deleteBot(pendingDeleteId);
    }
    setPendingDeleteId(null);
    setDeleteDialogOpen(false);
  };

  const getHueFromColour = (value: string) => {
    const match = value.match(/hsl\(\s*([0-9.]+)/i);
    return match ? Number(match[1]) : Math.random() * 360;
  };

  // — Add form state —
  const [botName, setBotName] = useState("");
  const [botUrl, setBotUrl] = useState("");
  const [botCaps, setBotCaps] = useState<GameType[]>([]);
  const [isPublic, setIsPublic] = useState(false);
  const [hue, setHue] = useState(Math.random() * 360);
  const [colour, setColour] = useState(generateColor(hue));
  const [emoji, setEmoji] = useState(emojiList[0] || "🐍");
  const [showEmojis, setShowEmojis] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const contrast = theme.palette.getContrastText(colour);

  // — Edit form state —
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingBotId, setEditingBotId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editCaps, setEditCaps] = useState<GameType[]>([]);
  const [editPublic, setEditPublic] = useState(false);
  const [editHue, setEditHue] = useState(0);
  const [editColour, setEditColour] = useState(generateColor(0));
  const [editEmoji, setEditEmoji] = useState(emojiList[0] || "🐍");
  const [showEditEmojis, setShowEditEmojis] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const editContrast = theme.palette.getContrastText(editColour);

  const randomizeEmojis = () => {
    const shuffled = [...emojiList].sort(() => 0.5 - Math.random());
    const pick = shuffled.includes(emoji) ? emoji : shuffled[0];
    setShowEmojis([pick, ...shuffled.filter((e) => e !== pick).slice(0, 11)]);
    setEmoji(pick);
  };

  const randomizeEditEmojis = () => {
    const shuffled = [...emojiList].sort(() => 0.5 - Math.random());
    const pick = shuffled.includes(editEmoji) ? editEmoji : shuffled[0];
    setShowEditEmojis([
      pick,
      ...shuffled.filter((e) => e !== pick).slice(0, 11),
    ]);
    setEditEmoji(pick);
  };

  useEffect(randomizeEmojis, []);
  useEffect(() => setColour(generateColor(hue)), [hue]);
  useEffect(() => setEditColour(generateColor(editHue)), [editHue]);

  const handleAdd = async () => {
    if (!userID) {
      setError("Login required");
      return;
    }
    if (!botName.trim()) {
      setError("Name required");
      return;
    }

    // normalize URL: strip trailing slashes
    const normalizedUrl = botUrl.trim().replace(/\/+$/, "");
    try {
      new URL(normalizedUrl);
    } catch {
      setError("Invalid URL");
      return;
    }

    if (!botCaps.length) {
      setError("Choose at least one skill");
      return;
    }

    setBusy(true);
    setError(null);

    const ref = doc(collection(db, "bots"));
    const newBot: Bot = {
      id: ref.id,
      owner: userID,
      name: botName.trim(),
      url: normalizedUrl,
      capabilities: botCaps,
      emoji,
      colour,
      public: isPublic,
      createdAt: serverTimestamp() as any,
    };

    try {
      await setDoc(ref, newBot);
      // reset form
      setBotName("");
      setBotUrl("");
      setBotCaps([]);
      setIsPublic(false);
      setHue(Math.random() * 360);
      randomizeEmojis();
    } finally {
      setBusy(false);
    }
  };

  const openEditDialog = (bot: Bot) => {
    setEditingBotId(bot.id);
    setEditName(bot.name);
    setEditUrl(bot.url);
    setEditCaps(bot.capabilities);
    setEditPublic(bot.public);
    const botHue = getHueFromColour(bot.colour);
    setEditHue(botHue);
    setEditColour(bot.colour);
    setEditError(null);
    setEditBusy(false);
    setEditDialogOpen(true);
    setShowEditEmojis(() => {
      const shuffled = [...emojiList].sort(() => 0.5 - Math.random());
      const pick = shuffled.includes(bot.emoji) ? bot.emoji : shuffled[0];
      setEditEmoji(pick);
      return [pick, ...shuffled.filter((e) => e !== pick).slice(0, 11)];
    });
  };

  const handleCloseEdit = () => {
    setEditingBotId(null);
    setEditDialogOpen(false);
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingBotId) return;
    if (!editName.trim()) {
      setEditError("Name required");
      return;
    }

    const normalizedUrl = editUrl.trim().replace(/\/+$/, "");
    try {
      new URL(normalizedUrl);
    } catch {
      setEditError("Invalid URL");
      return;
    }

    if (!editCaps.length) {
      setEditError("Choose at least one skill");
      return;
    }

    setEditBusy(true);
    setEditError(null);

    try {
      await updateDoc(doc(db, "bots", editingBotId), {
        name: editName.trim(),
        url: normalizedUrl,
        capabilities: editCaps,
        emoji: editEmoji,
        colour: editColour,
        public: editPublic,
      });
      setEditDialogOpen(false);
      setEditingBotId(null);
    } catch (saveError) {
      console.error("Failed to update bot", saveError);
      setEditError("Failed to save changes");
    } finally {
      setEditBusy(false);
    }
  };

  return (
    <Container sx={{ py: 3 }}>
      {/* My Bots List */}
      <Box>
        <Typography variant="h5" gutterBottom>
          My Bots
        </Typography>
        {bots.length === 0 ? (
          <Typography variant="body1" sx={{ mb: 2 }}>
            you got no bots m8. add one below.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small" sx={{ tableLayout: "fixed" }}>
              <colgroup>
                <col />
                <col style={{ width: "130px" }} />
              </colgroup>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Skills</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {bots.map((b) => (
                  <TableRow key={b.id} sx={{ backgroundColor: b.colour }}>
                    <TableCell
                      padding="none" // zero out the TD padding
                    >
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          height: "100%", // so px applies top/bottom too
                          p: 1, // now you control horizontal padding
                        }}
                      >
                        {/* left side */}
                        <Box sx={{ display: "flex", alignItems: "center" }}>
                          <Typography>
                            {b.emoji}{" "}
                            <Box component="span" sx={{ ml: 1 }}>
                              {b.name} {b.public && "(public 👀)"}
                            </Box>
                          </Typography>
                        </Box>

                        {/* right side */}
                        <Box sx={{ display: "flex", alignItems: "center" }}>
                          <Button
                            onClick={() => openEditDialog(b)}
                            disabled={busy || editBusy}
                            sx={{ minWidth: 0, height: 40 }}
                          >
                            ✏️
                          </Button>
                          <Button
                            onClick={() => openDeleteDialog(b.id)}
                            disabled={busy || editBusy}
                            sx={{ minWidth: 0, height: 40 }}
                          >
                            💣
                          </Button>
                        </Box>
                      </Box>
                    </TableCell>
                    <TableCell>{b.capabilities.join(", ")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      {/* Add Bot Form */}
      <Box
        component="form"
        onSubmit={(e) => {
          e.preventDefault();
          handleAdd();
        }}
        sx={{ mt: 4 }}
      >
        <Typography variant="h5" gutterBottom>
          Add a Bot
        </Typography>

        <TextField
          label="Name"
          value={botName}
          onChange={(e) => setBotName(e.target.value)}
          disabled={busy}
          fullWidth
          size="small"
          sx={{ mb: 2 }}
          placeholder="e.g. 'Cool Bot'"
        />

        <TextField
          label="URL"
          value={botUrl}
          onChange={(e) => setBotUrl(e.target.value)}
          disabled={busy}
          fullWidth
          size="small"
          sx={{ mb: 2 }}
          placeholder="e.g. https://mybot.com"
        />

        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            mb: 2,
            border: "2px solid #000",
          }}
        >
          <Hue
            hue={hue}
            onChange={(newHue: { h: number }) => setHue(newHue.h)}
            style={{ width: "100%", height: "20px" }}
          />
        </Box>

        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 2 }}>
          {showEmojis.map((e) => (
            <Button
              key={e}
              onClick={() => !busy && setEmoji(e)}
              size="small"
              sx={{
                fontSize: "1.5rem",
                width: 50,
                height: 50,
                backgroundColor: emoji === e ? colour : "white",
              }}
            >
              {e}
            </Button>
          ))}
          <Button onClick={randomizeEmojis} size="small">
            <Refresh fontSize="small" />
          </Button>
        </Box>

        <FormGroup row sx={{ gap: 1, mb: 2 }}>
          {availableGameTypes.map((g) => (
            <FormControlLabel
              key={g}
              control={
                <Checkbox
                  checked={botCaps.includes(g)}
                  onChange={() =>
                    setBotCaps((prev) =>
                      prev.includes(g)
                        ? prev.filter((x) => x !== g)
                        : [...prev, g],
                    )
                  }
                  size="small"
                />
              }
              label={g}
            />
          ))}
        </FormGroup>

        <FormControlLabel
          control={
            <Switch
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              size="small"
            />
          }
          label="Public"
          sx={{ mb: 2 }}
        />

        <Button
          type="submit"
          variant="contained"
          disabled={busy}
          sx={{ bgcolor: colour, color: contrast, mb: 2 }}
        >
          Add Bot
        </Button>

        {error && (
          <Typography color="error" variant="body2" sx={{ mb: 2 }}>
            {error}
          </Typography>
        )}
      </Box>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={handleCancelDelete}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          sx: {
            border: "2px solid black",
            borderRadius: 0,
            boxShadow: "none",
          },
        }}
      >
        <DialogTitle>Delete Bot</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete this bot?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelDelete}>Cancel</Button>
          <Button
            onClick={handleConfirmDelete}
            color="error"
            variant="contained"
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Bot Dialog */}
      <Dialog
        open={editDialogOpen}
        onClose={handleCloseEdit}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          sx: {
            border: "2px solid black",
            borderRadius: 0,
            boxShadow: "none",
          },
        }}
      >
        <DialogTitle>Edit Bot</DialogTitle>
        <DialogContent>
          <Box sx={{ mt: 1 }}>
            <TextField
              label="Name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              disabled={editBusy}
              fullWidth
              size="small"
              sx={{ mb: 2 }}
            />

            <TextField
              label="URL"
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              disabled={editBusy}
              fullWidth
              size="small"
              sx={{ mb: 2 }}
            />

            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                mb: 2,
                border: "2px solid #000",
              }}
            >
              <Hue
                hue={editHue}
                onChange={(newHue: { h: number }) => setEditHue(newHue.h)}
                style={{ width: "100%", height: "20px" }}
              />
            </Box>

            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 2 }}>
              {showEditEmojis.map((e) => (
                <Button
                  key={e}
                  onClick={() => !editBusy && setEditEmoji(e)}
                  size="small"
                  sx={{
                    fontSize: "1.5rem",
                    width: 50,
                    height: 50,
                    backgroundColor: editEmoji === e ? editColour : "white",
                  }}
                >
                  {e}
                </Button>
              ))}
              <Button onClick={randomizeEditEmojis} size="small">
                <Refresh fontSize="small" />
              </Button>
            </Box>

            <FormGroup row sx={{ gap: 1, mb: 2 }}>
              {availableGameTypes.map((g) => (
                <FormControlLabel
                  key={g}
                  control={
                    <Checkbox
                      checked={editCaps.includes(g)}
                      onChange={() =>
                        setEditCaps((prev) =>
                          prev.includes(g)
                            ? prev.filter((x) => x !== g)
                            : [...prev, g],
                        )
                      }
                      size="small"
                    />
                  }
                  label={g}
                />
              ))}
            </FormGroup>

            <FormControlLabel
              control={
                <Switch
                  checked={editPublic}
                  onChange={(e) => setEditPublic(e.target.checked)}
                  size="small"
                />
              }
              label="Public"
              sx={{ mb: 2 }}
            />

            {editError && (
              <Typography color="error" variant="body2" sx={{ mb: 2 }}>
                {editError}
              </Typography>
            )}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleCloseEdit} disabled={editBusy}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveEdit}
            variant="contained"
            disabled={editBusy}
            sx={{ bgcolor: editColour, color: editContrast }}
          >
            Save Changes
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default Bots;
