// src/pages/GamePage/GameSetup.tsx

import {
  arrayUnion,
  collection,
  deleteField,
  doc,
  getDocs,
  onSnapshot,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useUser } from "../../context/UserContext";
import { db, functions } from "../../firebaseConfig";
import { SnekConfiguration } from "../../components/SnekConfiguration";
import { TeamList } from "../../components/TeamList";
import { TeamSnekRules } from "../../constants/Rules";
import { nextTeamColor } from "../../utils/teamColors";

import {
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  IconButton,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Slider,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { Centaur, Team } from "@shared/types/Game";
import { useGameStateContext } from "../../context/GameStateContext";

// Define the board size mapping
const BOARD_SIZE_MAPPING = {
  small: { width: 11, height: 11 },
  medium: { width: 13, height: 13 },
  large: { width: 17, height: 17 },
  giant: { width: 21, height: 21 },
};

// Bounds for the free-form "Custom" board size. The minimum matches the
// Firestore rules (boardWidth/boardHeight >= 5, perimeter included); the
// maximum is a client-side sanity bound.
const MIN_BOARD_DIMENSION = 5;
const MAX_BOARD_DIMENSION = 99;
const MAX_TEAMS = 10;

type BoardSize = keyof typeof BOARD_SIZE_MAPPING | "custom";

const SNAKES_PER_TEAM_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

// Live centaur presence for the current setup: a centaur acks its pending
// invite by writing setups/{gameID}/centaurStatus/{centaurId}, so a doc's
// existence means "responsive".
const useCentaurStatuses = (
  sessionName: string,
  gameID: string,
): { [centaurId: string]: boolean } => {
  const [statuses, setStatuses] = useState<{ [centaurId: string]: boolean }>(
    {},
  );

  useEffect(() => {
    if (!gameID) return;
    setStatuses({});
    const statusesRef = collection(
      db,
      "sessions",
      sessionName,
      "setups",
      gameID,
      "centaurStatus",
    );
    const unsubscribe = onSnapshot(
      statusesRef,
      (snapshot) => {
        const next: { [centaurId: string]: boolean } = {};
        snapshot.forEach((docSnap) => {
          next[docSnap.id] = true;
        });
        setStatuses(next);
      },
      (error) => {
        console.error("Error in centaurStatus subscription:", error);
      },
    );
    return unsubscribe;
  }, [sessionName, gameID]);

  return statuses;
};

const GameSetup: React.FC = () => {
  const { userID } = useUser();
  const {
    gameSetup,
    centaurs,
    sessionName,
    gameID,
    gameState,
    session,
    isOwner,
  } = useGameStateContext();

  const hasOwner = session?.owner != null;
  const isConfigDisabled = hasOwner && !isOwner;
  const centaurStatuses = useCentaurStatuses(sessionName, gameID);

  const [secondsPerTurn, setSecondsPerTurn] = useState<string>("10");
  const [boardSize, setBoardSize] = useState<BoardSize>("medium");
  // Local text state for the Custom width/height inputs so partial typing
  // (e.g. clearing the field) doesn't write invalid values to Firestore.
  const [customWidth, setCustomWidth] = useState<string>("21");
  const [customHeight, setCustomHeight] = useState<string>("21");
  const [centaurSearchQuery, setCentaurSearchQuery] = useState("");
  const [maxTurnsEnabled, setMaxTurnsEnabled] = useState<boolean>(
    gameSetup?.maxTurns !== undefined,
  );
  const [maxTurns, setMaxTurns] = useState<number>(gameSetup?.maxTurns ?? 100);
  const [addingCentaur, setAddingCentaur] = useState<boolean>(false);
  const [hazardPercentage, setHazardPercentage] = useState<number>(
    gameSetup?.hazardPercentage ?? 0,
  );
  const [teamClustersEnabled, setTeamClustersEnabled] = useState<boolean>(
    gameSetup?.teamClustersEnabled ?? false,
  );
  const [fertileGroundEnabled, setFertileGroundEnabled] = useState<boolean>(
    gameSetup?.fertileGroundEnabled ?? false,
  );
  const [fertileGroundDensity, setFertileGroundDensity] = useState<number>(
    gameSetup?.fertileGroundDensity ?? 30,
  );
  const [fertileGroundClustering, setFertileGroundClustering] = useState<number>(
    gameSetup?.fertileGroundClustering ?? 10,
  );
  const usePreviewBoard = gameSetup?.usePreviewBoard ?? false;
  const [foodSpawnRate, setFoodSpawnRate] = useState<number>(
    gameSetup?.foodSpawnRate ?? 0.5,
  );
  const [invulnerabilityPotionEnabled, setInvulnerabilityPotionEnabled] = useState<boolean>(
    gameSetup?.invulnerabilityPotionEnabled ?? false,
  );
  const [invulnerabilityPotionSpawnRate, setInvulnerabilityPotionSpawnRate] = useState<number>(
    gameSetup?.invulnerabilityPotionSpawnRate ?? 0.15,
  );

  const [tournamentMode, setTournamentMode] = useState<boolean>(
    gameSetup?.tournamentMode ?? false,
  );
  const [remainingRounds, setRemainingRounds] = useState<number>(
    gameSetup?.remainingRounds ?? 1,
  );
  const [interludeDuration, setInterludeDuration] = useState<number>(
    gameSetup?.interludeDuration ?? 30,
  );
  const [scheduledStartInput, setScheduledStartInput] = useState<string>("");
  const [tournamentCountdown, setTournamentCountdown] = useState<string>("");

  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({});

  const ownerIDs = useMemo(
    () => Array.from(new Set(centaurs.map((c) => c.owner))),
    [centaurs],
  );

  useEffect(() => {
    if (ownerIDs.length === 0) {
      setOwnerNames({});
      return;
    }
    const batchSize = 10;
    const batches: string[][] = [];
    for (let i = 0; i < ownerIDs.length; i += batchSize) {
      batches.push(ownerIDs.slice(i, i + batchSize));
    }
    let cancelled = false;
    Promise.all(
      batches.map((batch) =>
        getDocs(query(collection(db, "users"), where("__name__", "in", batch))),
      ),
    ).then((snapshots) => {
      if (cancelled) return;
      const names: Record<string, string> = {};
      snapshots.forEach((snap) => {
        snap.forEach((d) => {
          const data = d.data();
          names[d.id] = data.name || d.id;
        });
      });
      setOwnerNames(names);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ownerIDs.join(",")]);

  const gameDocRef = doc(db, "sessions", sessionName, "setups", gameID);
  const sessionDocRef = doc(db, "sessions", sessionName);

  const handleAbdicate = async () => {
    await updateDoc(sessionDocRef, { owner: null });
  };

  const generatePreviewBoardFn = httpsCallable(functions, "generatePreviewBoard");
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usePreviewBoardRef = useRef(usePreviewBoard);
  useEffect(() => { usePreviewBoardRef.current = usePreviewBoard; }, [usePreviewBoard]);

  const requestCounterRef = useRef(0);
  const initialGenerationDoneRef = useRef(false);

  const firePreviewRequest = useCallback(async (shouldUncheck: boolean) => {
    if (shouldUncheck && usePreviewBoardRef.current) {
      updateDoc(gameDocRef, { usePreviewBoard: false });
    }
    const requestId = ++requestCounterRef.current;
    setIsGeneratingPreview(true);
    try {
      await generatePreviewBoardFn({ sessionID: sessionName, gameID });
    } catch (err) {
      console.error("Failed to generate preview board:", err);
    } finally {
      if (requestCounterRef.current === requestId) {
        setIsGeneratingPreview(false);
      }
    }
  }, [sessionName, gameID]);

  const debouncedRegeneratePreview = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setIsGeneratingPreview(true);
    debounceTimerRef.current = setTimeout(() => {
      firePreviewRequest(true);
    }, 500);
  }, [firePreviewRequest]);

  const immediateRegeneratePreview = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    firePreviewRequest(true);
  }, [firePreviewRequest]);

  useEffect(() => {
    // The preview callable is owner-gated server-side, so only the owner
    // should trigger the initial generation.
    if (!gameSetup || !isOwner || initialGenerationDoneRef.current) return;
    const hasPreviewData = gameSetup.presetFertileTiles || gameSetup.presetHazards || gameSetup.presetPlayerPositions || gameSetup.presetFood;
    initialGenerationDoneRef.current = true;
    if (!hasPreviewData) {
      firePreviewRequest(false);
    }
  }, [gameSetup, isOwner]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  // Inject the shake animation styles once the component mounts
  useEffect(() => {
    addStyles();
  }, []);

  // Update local state when gameSetup changes
  useEffect(() => {
    if (gameSetup) {
      // Update board size: match a preset when possible, otherwise show the
      // dimensions in the Custom inputs (covers sizes set by other clients).
      const currentSize = Object.entries(BOARD_SIZE_MAPPING).find(
        ([, dimensions]) =>
          dimensions.width === gameSetup.boardWidth &&
          dimensions.height === gameSetup.boardHeight,
      );
      if (currentSize) {
        setBoardSize(currentSize[0] as BoardSize);
      } else {
        setBoardSize("custom");
      }
      setCustomWidth(`${gameSetup.boardWidth}`);
      setCustomHeight(`${gameSetup.boardHeight}`);

      setSecondsPerTurn(`${gameSetup.maxTurnTime}`);

      if (gameSetup.maxTurns !== undefined) {
        setMaxTurns(gameSetup.maxTurns);
        setMaxTurnsEnabled(true);
      } else {
        setMaxTurnsEnabled(false);
      }

      if (gameSetup.hazardPercentage !== undefined) {
        setHazardPercentage(gameSetup.hazardPercentage);
      }

      setTeamClustersEnabled(gameSetup.teamClustersEnabled ?? false);
      setFertileGroundEnabled(gameSetup.fertileGroundEnabled ?? false);
      setFertileGroundDensity(gameSetup.fertileGroundDensity ?? 30);
      setFertileGroundClustering(gameSetup.fertileGroundClustering ?? 10);
      setFoodSpawnRate(gameSetup.foodSpawnRate ?? 0.5);
      setInvulnerabilityPotionEnabled(gameSetup.invulnerabilityPotionEnabled ?? false);
      setInvulnerabilityPotionSpawnRate(gameSetup.invulnerabilityPotionSpawnRate ?? 0.15);

      setTournamentMode(gameSetup.tournamentMode ?? false);
      setRemainingRounds(gameSetup.remainingRounds ?? 1);
      setInterludeDuration(gameSetup.interludeDuration ?? 30);
    }
  }, [gameSetup]);

  useEffect(() => {
    if (!gameSetup?.tournamentMode || !gameSetup?.scheduledStartTime) {
      setTournamentCountdown("");
      return;
    }
    if (gameSetup.remainingRounds !== undefined && gameSetup.remainingRounds <= 0) {
      setTournamentCountdown("");
      return;
    }
    const scheduledTs = gameSetup.scheduledStartTime as unknown as { seconds: number };
    if (!scheduledTs?.seconds) {
      setTournamentCountdown("");
      return;
    }
    const targetMs = scheduledTs.seconds * 1000;
    const update = () => {
      const diff = targetMs - Date.now();
      if (diff <= 0) {
        setTournamentCountdown("Starting...");
        return;
      }
      const totalSecs = Math.ceil(diff / 1000);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      setTournamentCountdown(`${mins}:${secs.toString().padStart(2, "0")}`);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [gameSetup?.tournamentMode, gameSetup?.scheduledStartTime, gameSetup?.remainingRounds]);

  if (!gameSetup) return null;

  const handleStart = async () => {
    await updateDoc(gameDocRef, {
      startRequested: true,
    });
  };

  const handleAddCentaur = async (centaur: Centaur) => {
    if (addingCentaur) return;
    if (gameSetup.teams.some((team) => team.id === centaur.id)) return;
    if (gameSetup.teams.length >= MAX_TEAMS) return;
    const newTeam: Team = {
      id: centaur.id,
      name: centaur.name,
      color: nextTeamColor(gameSetup.teams.map((team) => team.color)),
    };
    setAddingCentaur(true);
    try {
      await updateDoc(gameDocRef, {
        teams: arrayUnion(newTeam),
      });
    } finally {
      setAddingCentaur(false);
    }
    debouncedRegeneratePreview();
  };

  const handleRemoveTeam = async (teamID: string) => {
    const updatedTeams = gameSetup.teams.filter((team) => team.id !== teamID);
    await updateDoc(gameDocRef, {
      teams: updatedTeams,
    });
    debouncedRegeneratePreview();
  };

  const handleTeamColorChange = async (teamID: string, color: string) => {
    const updatedTeams = gameSetup.teams.map((team) =>
      team.id === teamID ? { ...team, color } : team,
    );
    await updateDoc(gameDocRef, {
      teams: updatedTeams,
    });
  };

  const handleSnakesPerTeamChange = async (event: SelectChangeEvent<number>) => {
    const value = Number(event.target.value);
    await updateDoc(gameDocRef, {
      snakesPerTeam: value,
    });
    debouncedRegeneratePreview();
  };

  // Handle max turns configuration
  const handleMaxTurnsChange = async (newMaxTurns: number) => {
    const sanitizedValue = Math.min(1000, Math.max(1, newMaxTurns));
    setMaxTurns(sanitizedValue);

    if (maxTurnsEnabled) {
      await updateDoc(gameDocRef, {
        maxTurns: sanitizedValue,
      });
    }
  };

  const handleMaxTurnsToggle = async (enabled: boolean) => {
    setMaxTurnsEnabled(enabled);

    if (enabled) {
      const sanitizedValue = Math.max(1, maxTurns);
      setMaxTurns(sanitizedValue);
      await updateDoc(gameDocRef, {
        maxTurns: sanitizedValue,
      });
    } else {
      await updateDoc(gameDocRef, {
        maxTurns: deleteField(),
      });
    }
  };

  // Handle hazard percentage configuration
  const handleHazardPercentageChange = async (newHazardPercentage: number) => {
    const sanitizedValue = Math.max(0, Math.min(100, newHazardPercentage));
    setHazardPercentage(sanitizedValue);
    await updateDoc(gameDocRef, {
      hazardPercentage: sanitizedValue,
    });
    debouncedRegeneratePreview();
  };

  const handleFertileGroundToggle = async (enabled: boolean) => {
    setFertileGroundEnabled(enabled);
    await updateDoc(gameDocRef, {
      fertileGroundEnabled: enabled,
    });
    debouncedRegeneratePreview();
  };

  const handleFertileGroundDensityChange = async (newDensity: number) => {
    const sanitizedValue = Math.max(5, Math.min(80, newDensity));
    setFertileGroundDensity(sanitizedValue);
    await updateDoc(gameDocRef, {
      fertileGroundDensity: sanitizedValue,
    });
    debouncedRegeneratePreview();
  };

  const handleFertileGroundClusteringChange = async (newClustering: number) => {
    const sanitizedValue = Math.max(1, Math.min(20, newClustering));
    setFertileGroundClustering(sanitizedValue);
    await updateDoc(gameDocRef, {
      fertileGroundClustering: sanitizedValue,
    });
    debouncedRegeneratePreview();
  };

  const handleUsePreviewBoardChange = async (enabled: boolean) => {
    await updateDoc(gameDocRef, {
      usePreviewBoard: enabled,
    });
  };

  const handleFoodSpawnRateChange = async (newRate: number) => {
    const sanitizedValue = Math.max(0, Math.min(5, Math.round(newRate * 4) / 4));
    setFoodSpawnRate(sanitizedValue);
    await updateDoc(gameDocRef, {
      foodSpawnRate: sanitizedValue,
    });
  };

  const handleTeamClustersToggle = async (enabled: boolean) => {
    setTeamClustersEnabled(enabled);
    await updateDoc(gameDocRef, {
      teamClustersEnabled: enabled,
    });
    debouncedRegeneratePreview();
  };

  const handleInvulnerabilityPotionToggle = async (enabled: boolean) => {
    setInvulnerabilityPotionEnabled(enabled);
    await updateDoc(gameDocRef, {
      invulnerabilityPotionEnabled: enabled,
    });
  };

  const handleInvulnerabilityPotionSpawnRateChange = async (newRate: number) => {
    const sanitizedValue = Math.max(0.01, Math.min(0.2, Math.round(newRate * 100) / 100));
    setInvulnerabilityPotionSpawnRate(sanitizedValue);
    await updateDoc(gameDocRef, {
      invulnerabilityPotionSpawnRate: sanitizedValue,
    });
  };

  const handleTournamentModeToggle = async (enabled: boolean) => {
    setTournamentMode(enabled);
    if (enabled) {
      await updateDoc(gameDocRef, {
        tournamentMode: true,
        remainingRounds: remainingRounds,
        interludeDuration: interludeDuration,
      });
    } else {
      await updateDoc(gameDocRef, {
        tournamentMode: false,
        scheduledStartTime: deleteField(),
        remainingRounds: deleteField(),
        interludeDuration: deleteField(),
      });
      setScheduledStartInput("");
    }
  };

  const handleRemainingRoundsChange = async (value: number) => {
    const sanitized = Math.max(0, Math.round(value));
    setRemainingRounds(sanitized);
    await updateDoc(gameDocRef, { remainingRounds: sanitized });
  };

  const handleInterludeDurationChange = async (value: number) => {
    const sanitized = Math.max(0, Math.round(value));
    setInterludeDuration(sanitized);
    await updateDoc(gameDocRef, { interludeDuration: sanitized });
  };

  const handleScheduledStartTimeSet = async () => {
    if (!scheduledStartInput) return;
    const date = new Date(scheduledStartInput);
    if (isNaN(date.getTime())) return;
    const ts = Timestamp.fromDate(date);
    await updateDoc(gameDocRef, { scheduledStartTime: ts });
  };

  const handleClearScheduledStart = async () => {
    setScheduledStartInput("");
    await updateDoc(gameDocRef, { scheduledStartTime: deleteField() });
  };

  // Handle max turn time configuration
  const handleSecondsPerTurnChange = async (newSeconds: number) => {
    const sanitizedValue = Math.max(0.5, Math.min(300, newSeconds)); // Min 0.5s, max 5 minutes
    setSecondsPerTurn(`${sanitizedValue}`);
    await updateDoc(gameDocRef, {
      maxTurnTime: sanitizedValue,
    });
  };

  // Handler for selecting board size
  const handleBoardSizeChange = async (event: SelectChangeEvent<BoardSize>) => {
    const selectedBoardSize = event.target.value as BoardSize;
    setBoardSize(selectedBoardSize);

    if (selectedBoardSize === "custom") {
      // Seed the custom inputs from the current board; no Firestore write
      // until a dimension is actually edited.
      setCustomWidth(`${gameSetup?.boardWidth ?? 21}`);
      setCustomHeight(`${gameSetup?.boardHeight ?? 21}`);
      return;
    }

    const { width, height } = BOARD_SIZE_MAPPING[selectedBoardSize];

    if (!gameSetup?.started) {
      await updateDoc(gameDocRef, {
        boardWidth: width,
        boardHeight: height,
      });
    }
    debouncedRegeneratePreview();
  };

  // Handler for the Custom width/height inputs. Writes only complete, valid
  // integer dimensions; partial input just updates the local field.
  const handleCustomDimensionChange = async (
    dimension: "width" | "height",
    raw: string,
  ) => {
    if (dimension === "width") setCustomWidth(raw);
    else setCustomHeight(raw);

    const value = parseInt(raw, 10);
    if (
      isNaN(value) ||
      value < MIN_BOARD_DIMENSION ||
      value > MAX_BOARD_DIMENSION
    ) {
      return;
    }
    if (!gameSetup?.started) {
      await updateDoc(gameDocRef, {
        [dimension === "width" ? "boardWidth" : "boardHeight"]: value,
      });
    }
    debouncedRegeneratePreview();
  };

  if (gameState) return null;

  const { started } = gameSetup;

  const boardValid =
    gameSetup.boardWidth >= MIN_BOARD_DIMENSION &&
    gameSetup.boardWidth <= MAX_BOARD_DIMENSION &&
    gameSetup.boardHeight >= MIN_BOARD_DIMENSION &&
    gameSetup.boardHeight <= MAX_BOARD_DIMENSION;
  const turnTimeValid = gameSetup.maxTurnTime > 0;
  const enoughTeams = gameSetup.teams.length >= 2;
  const interiorCells =
    (gameSetup.boardWidth - 2) * (gameSetup.boardHeight - 2);
  const boardFits =
    gameSetup.teams.length * gameSetup.snakesPerTeam <= interiorCells;
  const canStartGame = enoughTeams && boardValid && turnTimeValid && boardFits;

  const teamValidationMessage = !enoughTeams
    ? gameSetup.teams.length === 0
      ? "Add centaurs to create teams before starting the game"
      : "At least 2 teams are needed before starting the game"
    : !boardFits
      ? "Board is too small for this many snakes — shrink the teams, lower snakes per team, or grow the board"
      : "";

  return (
    <Stack spacing={2} pt={2}>
      {isOwner && (
        <Button
          onClick={handleAbdicate}
          variant="outlined"
          color="warning"
          fullWidth
        >
          Abdicate Ownership
        </Button>
      )}
      {/* Start / Tournament Section */}
      {tournamentMode ? (
        <Box
          sx={{
            border: "2px solid black",
            padding: 2,
            borderRadius: "0px",
            textAlign: "center",
          }}
        >
          {gameSetup.scheduledStartTime && !(gameSetup.remainingRounds !== undefined && gameSetup.remainingRounds <= 0) ? (
            <>
              <Typography variant="h5" sx={{ fontFamily: "monospace" }}>
                {tournamentCountdown || "Scheduled"}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {(() => {
                  const ts = gameSetup.scheduledStartTime as unknown as { seconds: number };
                  if (!ts?.seconds) return "";
                  return new Date(ts.seconds * 1000).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "long",
                  });
                })()}
              </Typography>
            </>
          ) : (
            <Typography variant="h6" color="text.secondary">
              Waiting for schedule...
            </Typography>
          )}
          {gameSetup.remainingRounds !== undefined && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Remaining rounds: {gameSetup.remainingRounds}
            </Typography>
          )}
        </Box>
      ) : (
        <>
          <Button
            disabled={
              started ||
              gameSetup.startRequested ||
              !canStartGame ||
              isConfigDisabled
            }
            onClick={handleStart}
            variant="contained"
            sx={{ height: "70px", fontSize: "32px" }}
            className={
              canStartGame && !started && !gameSetup.startRequested && !isConfigDisabled
                ? "shake"
                : ""
            }
            fullWidth
          >
            {gameSetup.startRequested ? "Game starting" : "Start game"}
          </Button>
          {teamValidationMessage && (
            <Typography color="error" sx={{ textAlign: "center", mt: 1 }}>
              {teamValidationMessage}
            </Typography>
          )}
        </>
      )}
      <Box sx={{ display: "flex", gap: 2 }}>
        {/* Game Size */}
        <FormControl variant="outlined" sx={{ flex: 1 }}>
          <InputLabel id="board-size-label">Size</InputLabel>
          <Select
            labelId="board-size-label"
            value={boardSize}
            onChange={handleBoardSizeChange}
            disabled={started || isConfigDisabled}
            label="Board Size"
          >
            <MenuItem value="small">Small (11x11)</MenuItem>
            <MenuItem value="medium">Medium (13x13)</MenuItem>
            <MenuItem value="large">Large (17x17)</MenuItem>
            <MenuItem value="giant">Giant (21x21)</MenuItem>
            <MenuItem value="custom">
              {boardSize === "custom"
                ? `Custom (${gameSetup.boardWidth}x${gameSetup.boardHeight})`
                : "Custom…"}
            </MenuItem>
          </Select>
        </FormControl>

        {/* Custom board dimensions (perimeter included) */}
        {boardSize === "custom" && (
          <>
            <TextField
              label="Width"
              type="number"
              value={customWidth}
              onChange={(e) => handleCustomDimensionChange("width", e.target.value)}
              disabled={started || isConfigDisabled}
              sx={{ flex: 1 }}
              inputProps={{ min: MIN_BOARD_DIMENSION, max: MAX_BOARD_DIMENSION, step: 1 }}
              error={(() => {
                const v = parseInt(customWidth, 10);
                return isNaN(v) || v < MIN_BOARD_DIMENSION || v > MAX_BOARD_DIMENSION;
              })()}
            />
            <TextField
              label="Height"
              type="number"
              value={customHeight}
              onChange={(e) => handleCustomDimensionChange("height", e.target.value)}
              disabled={started || isConfigDisabled}
              sx={{ flex: 1 }}
              inputProps={{ min: MIN_BOARD_DIMENSION, max: MAX_BOARD_DIMENSION, step: 1 }}
              error={(() => {
                const v = parseInt(customHeight, 10);
                return isNaN(v) || v < MIN_BOARD_DIMENSION || v > MAX_BOARD_DIMENSION;
              })()}
            />
          </>
        )}

        {/* Turn Time */}
        <TextField
          label="Turn Time (s)"
          type="number"
          value={secondsPerTurn}
          onChange={(e) => {
            const value = parseFloat(e.target.value);
            if (!isNaN(value)) {
              handleSecondsPerTurnChange(value);
            }
          }}
          disabled={started || isConfigDisabled}
          sx={{ flex: 1 }}
          inputProps={{ min: 0.5, max: 300, step: 0.1 }}
        />

        {/* Snakes per Team */}
        <FormControl variant="outlined" sx={{ flex: 1 }}>
          <InputLabel id="snakes-per-team-label">Snakes/Team</InputLabel>
          <Select
            labelId="snakes-per-team-label"
            value={gameSetup.snakesPerTeam}
            onChange={handleSnakesPerTeamChange}
            disabled={started || isConfigDisabled}
            label="Snakes/Team"
          >
            {SNAKES_PER_TEAM_OPTIONS.map((n) => (
              <MenuItem key={n} value={n}>
                {n}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* Game rules */}
      <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
        <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
          Rules
        </InputLabel>
        <Box
          sx={{
            border: "2px solid black",
            padding: 2,
            borderRadius: "0px",
            minHeight: "56px",
            display: "flex",
            alignItems: "start",
            flexDirection: "column",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
          }}
        >
          <TeamSnekRules />
        </Box>
      </FormControl>
      {/* Tournament Mode */}
      <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
        <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
          Tournament Mode
        </InputLabel>
        <Box
          sx={{
            border: "2px solid black",
            padding: 2,
            borderRadius: "0px",
            minHeight: "56px",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <FormControlLabel
            control={
              <Checkbox
                checked={tournamentMode}
                onChange={(e) => handleTournamentModeToggle(e.target.checked)}
                disabled={started || isConfigDisabled}
              />
            }
            label="Tournament Mode"
          />
          {tournamentMode && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Box sx={{ display: "flex", gap: 2, alignItems: "flex-end" }}>
                <TextField
                  label="Scheduled Start Time"
                  type="datetime-local"
                  value={scheduledStartInput}
                  onChange={(e) => setScheduledStartInput(e.target.value)}
                  disabled={isConfigDisabled}
                  sx={{ flex: 1 }}
                  InputLabelProps={{ shrink: true }}
                  inputProps={{ step: 1 }}
                />
                <Button
                  onClick={handleScheduledStartTimeSet}
                  disabled={!scheduledStartInput || isConfigDisabled}
                  variant="outlined"
                  size="small"
                >
                  Set
                </Button>
                <Button
                  onClick={handleClearScheduledStart}
                  disabled={isConfigDisabled}
                  variant="outlined"
                  size="small"
                >
                  Clear
                </Button>
              </Box>
              <Box sx={{ display: "flex", gap: 2 }}>
                <TextField
                  label="Remaining Rounds"
                  type="number"
                  value={remainingRounds}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val)) handleRemainingRoundsChange(val);
                  }}
                  disabled={isConfigDisabled}
                  sx={{ flex: 1 }}
                  inputProps={{ min: 0, step: 1 }}
                />
                <TextField
                  label="Interlude Duration (s)"
                  type="number"
                  value={interludeDuration}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val)) handleInterludeDurationChange(val);
                  }}
                  disabled={isConfigDisabled}
                  sx={{ flex: 1 }}
                  inputProps={{ min: 0, step: 1 }}
                />
              </Box>
            </Stack>
          )}
        </Box>
      </FormControl>

      {/* Teams */}
      <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
        <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
          Teams
        </InputLabel>
        <Box
          sx={{
            border: "2px solid black",
            padding: 1,
            borderRadius: "0px",
            minHeight: "56px",
          }}
        >
          <TeamList
            teams={gameSetup.teams}
            onColorChange={handleTeamColorChange}
            onRemove={handleRemoveTeam}
            disabled={started || isConfigDisabled}
            centaurStatuses={centaurStatuses}
          />
        </Box>
      </FormControl>

      {/* Available Centaurs */}
      {centaurs.length > 0 && (
        <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
          <InputLabel shrink sx={{ backgroundColor: "white", px: 1, zIndex: 2 }}>
            Available Centaurs
          </InputLabel>
          <Box
            sx={{
              border: "2px solid black",
              borderRadius: "0px",
              minHeight: "56px",
              maxHeight: "300px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <Box sx={{ px: 1, pt: 1, pb: 0.5, borderBottom: "1px solid #ddd", flexShrink: 0 }}>
              <TextField
                size="small"
                fullWidth
                placeholder="Search centaurs..."
                value={centaurSearchQuery}
                onChange={(e) => setCentaurSearchQuery(e.target.value)}
                InputProps={{
                  endAdornment: centaurSearchQuery ? (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        onClick={() => setCentaurSearchQuery("")}
                        edge="end"
                        aria-label="clear search"
                      >
                        ✕
                      </IconButton>
                    </InputAdornment>
                  ) : null,
                }}
                sx={{
                  "& .MuiOutlinedInput-root": {
                    borderRadius: "0px",
                    "& fieldset": { borderColor: "black", borderWidth: "2px" },
                    "&:hover fieldset": { borderColor: "black" },
                    "&.Mui-focused fieldset": { borderColor: "black" },
                  },
                }}
              />
            </Box>
            <Box sx={{ overflowY: "auto", flexGrow: 1 }}>
            {(() => {
              const searchLower = centaurSearchQuery.toLowerCase();
              const filtered = centaurSearchQuery
                ? centaurs.filter((centaur) => centaur.name.toLowerCase().includes(searchLower))
                : centaurs;
              const grouped: Record<string, typeof centaurs> = {};
              filtered.forEach((centaur) => {
                if (!grouped[centaur.owner]) grouped[centaur.owner] = [];
                grouped[centaur.owner].push(centaur);
              });
              Object.values(grouped).forEach((group) =>
                group.sort((a, b) => a.name.localeCompare(b.name)),
              );
              const ownerOrder = Object.keys(grouped).sort((a, b) => {
                if (a === userID) return -1;
                if (b === userID) return 1;
                const nameA = ownerNames[a] || a;
                const nameB = ownerNames[b] || b;
                return nameA.localeCompare(nameB);
              });

              if (ownerOrder.length === 0 && centaurSearchQuery) {
                return (
                  <Typography sx={{ px: 2, py: 2, color: "#999", fontSize: "0.9rem" }}>
                    No centaurs match "{centaurSearchQuery}"
                  </Typography>
                );
              }

              return ownerOrder.map((ownerID) => (
                <Box key={ownerID}>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      px: 2,
                      py: 1,
                      backgroundColor: "#f0f0f0",
                      borderBottom: "1px solid #ddd",
                      position: "sticky",
                      top: 0,
                      zIndex: 1,
                    }}
                  >
                    <Typography
                      sx={{ fontSize: "0.8rem", fontWeight: 600, color: "#555" }}
                    >
                      {ownerID === userID
                        ? `${ownerNames[ownerID] || "You"} (You)`
                        : ownerNames[ownerID] || ownerID}
                    </Typography>
                  </Box>
                  {grouped[ownerID].map((centaur) => {
                    const isInGame = gameSetup.teams.some(
                      (team) => team.id === centaur.id,
                    );

                    return (
                      <Box
                        key={centaur.id}
                        title={centaur.name}
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 1,
                          px: 2,
                          py: 1,
                          borderBottom: "1px solid #eee",
                        }}
                      >
                        <Link
                          to={`/ladder/${centaur.id}`}
                          style={{
                            fontWeight: 500,
                            flexGrow: 1,
                            wordBreak: "break-word",
                            color: "inherit",
                            textDecoration: "none",
                          }}
                          onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
                            e.currentTarget.style.textDecoration = "underline";
                          }}
                          onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
                            e.currentTarget.style.textDecoration = "none";
                          }}
                        >
                          {centaur.name}
                          {isInGame && " (IN GAME)"}
                        </Link>
                        <Button
                          size="small"
                          variant="outlined"
                          disabled={
                            isInGame ||
                            started ||
                            isConfigDisabled ||
                            addingCentaur ||
                            gameSetup.teams.length >= MAX_TEAMS
                          }
                          onClick={() => handleAddCentaur(centaur)}
                          sx={{ flexShrink: 0 }}
                        >
                          Add
                        </Button>
                      </Box>
                    );
                  })}
                </Box>
              ));
            })()}
            </Box>
          </Box>
        </FormControl>
      )}

      {/* Snek Configuration */}
      <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
        <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
          Snek Configuration
        </InputLabel>
        <Box
          sx={{
            border: "2px solid black",
            padding: 2,
            borderRadius: "0px",
            minHeight: "56px",
          }}
        >
          <Box sx={isConfigDisabled ? { pointerEvents: 'none', opacity: 0.6 } : {}}>
            <SnekConfiguration
              maxTurns={maxTurns}
              maxTurnsEnabled={maxTurnsEnabled}
              onMaxTurnsToggle={handleMaxTurnsToggle}
              onMaxTurnsChange={handleMaxTurnsChange}
              hazardPercentage={hazardPercentage}
              onHazardPercentageChange={handleHazardPercentageChange}
              fertileGroundEnabled={fertileGroundEnabled}
              onFertileGroundToggle={handleFertileGroundToggle}
              fertileGroundDensity={fertileGroundDensity}
              onFertileGroundDensityChange={handleFertileGroundDensityChange}
              fertileGroundClustering={fertileGroundClustering}
              onFertileGroundClusteringChange={handleFertileGroundClusteringChange}
              foodSpawnRate={foodSpawnRate}
              onFoodSpawnRateChange={handleFoodSpawnRateChange}
              boardWidth={gameSetup.boardWidth}
              boardHeight={gameSetup.boardHeight}
              usePreviewBoard={usePreviewBoard}
              onUsePreviewBoardChange={handleUsePreviewBoardChange}
              syncedPreviewData={
                gameSetup.presetFertileTiles || gameSetup.presetHazards || gameSetup.presetPlayerPositions || gameSetup.presetFood
                  ? {
                      fertileTiles: gameSetup.presetFertileTiles || [],
                      hazards: gameSetup.presetHazards || [],
                      playerPositions: gameSetup.presetPlayerPositions || {},
                      food: gameSetup.presetFood || [],
                    }
                  : null
              }
              isGeneratingPreview={isGeneratingPreview}
              onRefreshPreview={immediateRegeneratePreview}
              teams={gameSetup.teams}
              snakesPerTeam={gameSetup.snakesPerTeam}
            />
          </Box>
        </Box>
      </FormControl>

      {/* Team Cluster */}
      <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
        <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
          Team Cluster
        </InputLabel>
        <Box
          sx={{
            border: "2px solid black",
            padding: 2,
            borderRadius: "0px",
            minHeight: "56px",
            display: "flex",
            alignItems: "center",
          }}
        >
          <FormControlLabel
            control={
              <Checkbox
                checked={teamClustersEnabled}
                onChange={(e) => handleTeamClustersToggle(e.target.checked)}
                disabled={started || isConfigDisabled}
              />
            }
            label="Team cluster"
          />
        </Box>
      </FormControl>

      {/* Invulnerability Potions */}
      <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
        <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
          (In)vulnerability Potions
        </InputLabel>
        <Box
          sx={{
            border: "2px solid black",
            padding: 2,
            borderRadius: "0px",
            minHeight: "56px",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <FormControlLabel
            control={
              <Checkbox
                checked={invulnerabilityPotionEnabled}
                onChange={(e) => handleInvulnerabilityPotionToggle(e.target.checked)}
                disabled={started || isConfigDisabled}
              />
            }
            label="(In)vulnerability Potions"
          />
          {invulnerabilityPotionEnabled && (
            <Box sx={{ px: 2, pt: 1 }}>
              <Typography variant="body2" gutterBottom>
                Spawn Rate: {invulnerabilityPotionSpawnRate.toFixed(2)}/turn
              </Typography>
              <Slider
                value={invulnerabilityPotionSpawnRate}
                onChange={(_, value) => handleInvulnerabilityPotionSpawnRateChange(value as number)}
                min={0.01}
                max={0.2}
                step={0.01}
                disabled={started || isConfigDisabled}
                valueLabelDisplay="auto"
                valueLabelFormat={(value) => `${value.toFixed(2)}/turn`}
              />
            </Box>
          )}
        </Box>
      </FormControl>
    </Stack>
  );
};

export default GameSetup;

// Function to insert keyframe and class rules separately
const addStyles = () => {
  const styleSheet = document.styleSheets[0];

  // Insert the keyframes animation
  styleSheet.insertRule(
    `
    @keyframes shake {
      0% { transform: translateX(0); }
      25% { transform: translateX(-5px); }
      50% { transform: translateX(5px); }
      75% { transform: translateX(-5px); }
      100% { transform: translateX(0); }
    }
  `,
    styleSheet.cssRules.length,
  );

  // Insert the shake class rule with infinite iterations
  styleSheet.insertRule(
    `
    .shake {
      animation: shake 0.5s ease infinite;
    }
  `,
    styleSheet.cssRules.length,
  );
};
