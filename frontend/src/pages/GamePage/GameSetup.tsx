// src/pages/GamePage/GameSetup.tsx

import {
  arrayUnion,
  collection,
  deleteField,
  doc,
  getDocs,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CentaurLink } from "../../components/CentaurLink";
import { useUser } from "../../context/UserContext";
import { db, functions } from "../../firebaseConfig";
import { useFirestoreSubscription } from "../../hooks/useFirestoreSubscription";
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
  SxProps,
  TextField,
  Theme,
  Typography,
} from "@mui/material";
import { Centaur, Team, UnitCounts, UnitMaxHealth, UnitType } from "@shared/types/Game";
import { PIECE_GLYPHS, SNAKE_GLYPH } from "../../utils/unitGlyphs";
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

const UNIT_COUNT_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const MAX_UNITS_PER_TEAM = 26;

const UNIT_TYPES: { type: UnitType; label: string }[] = [
  { type: "snake", label: `${SNAKE_GLYPH} Snakes` },
  { type: "pawn", label: `${PIECE_GLYPHS.pawn} Pawns` },
  { type: "knight", label: `${PIECE_GLYPHS.knight} Knights` },
  { type: "bishop", label: `${PIECE_GLYPHS.bishop} Bishops` },
  { type: "rook", label: `${PIECE_GLYPHS.rook} Rooks` },
  { type: "queen", label: `${PIECE_GLYPHS.queen} Queens` },
  { type: "king", label: `${PIECE_GLYPHS.king} Kings` },
];

const totalUnitCount = (counts: UnitCounts): number =>
  Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);

// Live centaur presence for the current setup: a centaur acks its pending
// invite by writing setups/{gameID}/centaurStatus/{centaurId} with
// ready == true. A recheck flips existing acks to ready == false; live
// centaurs answer by flipping them back.
const useCentaurStatuses = (
  sessionName: string,
  gameID: string,
): {
  statuses: { [centaurId: string]: boolean };
  recheck: () => Promise<void>;
} => {
  const [statuses, setStatuses] = useState<{ [centaurId: string]: boolean }>(
    {},
  );
  const ackedIDsRef = useRef<string[]>([]);

  // Reset the tracked acks whenever the setup being watched changes; the
  // subscription below re-populates them.
  useEffect(() => {
    if (!gameID) return;
    setStatuses({});
    ackedIDsRef.current = [];
  }, [sessionName, gameID]);

  useFirestoreSubscription({
    buildTarget: () =>
      gameID
        ? collection(db, "sessions", sessionName, "setups", gameID, "centaurStatus")
        : null,
    deps: [sessionName, gameID],
    logLabel: "centaurStatus",
    includeMetadataChanges: false,
    onSnapshot: (snapshot) => {
      const next: { [centaurId: string]: boolean } = {};
      const acked: string[] = [];
      snapshot.forEach((docSnap) => {
        next[docSnap.id] = docSnap.data().ready === true;
        acked.push(docSnap.id);
      });
      setStatuses(next);
      ackedIDsRef.current = acked;
    },
  });

  const recheck = useCallback(async () => {
    // Only existing ack docs can go stale; absent docs already read as
    // "no response".
    await Promise.all(
      ackedIDsRef.current.map((centaurId) =>
        updateDoc(
          doc(db, "sessions", sessionName, "setups", gameID, "centaurStatus", centaurId),
          { ready: false },
        ).catch((error) => {
          console.error(`Failed to reset health of ${centaurId}:`, error);
        }),
      ),
    );
  }, [sessionName, gameID]);

  return { statuses, recheck };
};

// The bordered settings panel every section of the setup page sits in: an
// outlined FormControl whose shrunk label floats over a 2px-bordered box.
// Per-panel styling (padding, flex layout, the centaur list's label zIndex)
// comes in via labelSx/contentSx so each panel keeps its exact look.
const SettingsPanel: React.FC<{
  label: string;
  labelSx?: SxProps<Theme>;
  contentSx?: SxProps<Theme>;
  children: React.ReactNode;
}> = ({ label, labelSx, contentSx, children }) => (
  <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
    <InputLabel
      shrink
      sx={[
        { backgroundColor: "white", px: 1 },
        ...(Array.isArray(labelSx) ? labelSx : [labelSx]),
      ]}
    >
      {label}
    </InputLabel>
    <Box
      sx={[
        {
          border: "2px solid black",
          borderRadius: "0px",
          minHeight: "56px",
        },
        ...(Array.isArray(contentSx) ? contentSx : [contentSx]),
      ]}
    >
      {children}
    </Box>
  </FormControl>
);

// The searchable centaur list body: centaurs filtered by the search query,
// grouped by owner (current user first), each row linking to the ladder with
// an Add button.
const CentaurPicker: React.FC<{
  centaurs: Centaur[];
  searchQuery: string;
  userID: string;
  ownerNames: Record<string, string>;
  teams: Team[];
  started: boolean;
  isConfigDisabled: boolean;
  addingCentaur: boolean;
  onAddCentaur: (centaur: Centaur) => void;
}> = ({
  centaurs,
  searchQuery,
  userID,
  ownerNames,
  teams,
  started,
  isConfigDisabled,
  addingCentaur,
  onAddCentaur,
}) => {
  const searchLower = searchQuery.toLowerCase();
  const filtered = searchQuery
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

  if (ownerOrder.length === 0 && searchQuery) {
    return (
      <Typography sx={{ px: 2, py: 2, color: "#999", fontSize: "0.9rem" }}>
        No centaurs match "{searchQuery}"
      </Typography>
    );
  }

  return (
    <>
      {ownerOrder.map((ownerID) => (
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
            const isInGame = teams.some((team) => team.id === centaur.id);

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
                <CentaurLink
                  centaurId={centaur.id}
                  style={{
                    fontWeight: 500,
                    flexGrow: 1,
                    wordBreak: "break-word",
                  }}
                >
                  {centaur.name}
                  {isInGame && " (IN GAME)"}
                </CentaurLink>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={
                    isInGame ||
                    started ||
                    isConfigDisabled ||
                    addingCentaur ||
                    teams.length >= MAX_TEAMS
                  }
                  onClick={() => onAddCentaur(centaur)}
                  sx={{ flexShrink: 0 }}
                >
                  Add
                </Button>
              </Box>
            );
          })}
        </Box>
      ))}
    </>
  );
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
  const { statuses: centaurStatuses, recheck: recheckCentaurHealth } =
    useCentaurStatuses(sessionName, gameID);

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
  const [hazardDamage, setHazardDamage] = useState<number>(
    gameSetup?.hazardDamage ?? 100,
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

  const [pawnPromotionWeight, setPawnPromotionWeight] = useState<number>(
    gameSetup?.pawnPromotionWeight ?? 10,
  );
  const [maxHealthPerUnit, setMaxHealthPerUnit] = useState<UnitMaxHealth>(
    gameSetup?.maxHealthPerUnit ?? {},
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

  const gameDocRef = useMemo(
    () => doc(db, "sessions", sessionName, "setups", gameID),
    [sessionName, gameID],
  );
  const sessionDocRef = useMemo(
    () => doc(db, "sessions", sessionName),
    [sessionName],
  );

  const handleAbdicate = async () => {
    await updateDoc(sessionDocRef, { owner: null });
  };

  const generatePreviewBoardFn = useMemo(
    () => httpsCallable(functions, "generatePreviewBoard"),
    [],
  );
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
    // gameDocRef/generatePreviewBoardFn are memoized above, so listing them
    // changes nothing about when this callback is recreated.
  }, [sessionName, gameID, gameDocRef, generatePreviewBoardFn]);

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
      setHazardDamage(gameSetup.hazardDamage ?? 100);

      setTeamClustersEnabled(gameSetup.teamClustersEnabled ?? false);
      setFertileGroundEnabled(gameSetup.fertileGroundEnabled ?? false);
      setFertileGroundDensity(gameSetup.fertileGroundDensity ?? 30);
      setFertileGroundClustering(gameSetup.fertileGroundClustering ?? 10);
      setFoodSpawnRate(gameSetup.foodSpawnRate ?? 0.5);
      setInvulnerabilityPotionEnabled(gameSetup.invulnerabilityPotionEnabled ?? false);
      setInvulnerabilityPotionSpawnRate(gameSetup.invulnerabilityPotionSpawnRate ?? 0.15);
      setPawnPromotionWeight(gameSetup.pawnPromotionWeight ?? 10);
      setMaxHealthPerUnit(gameSetup.maxHealthPerUnit ?? {});

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

  // Current per-team unit counts. Absent unitsPerTeam means snakesPerTeam
  // snakes and zero of every chess piece.
  const unitCounts: UnitCounts = gameSetup.unitsPerTeam ?? {
    snake: gameSetup.snakesPerTeam,
  };
  const unitCount = (type: UnitType): number => unitCounts[type] ?? 0;
  const totalUnits = totalUnitCount(unitCounts);

  // Whether a unit type's max health is meaningful for this setup. Normally
  // that means "some are fielded", but a pawn promotes to a queen, so queen
  // max health matters whenever pawns are in play even with zero queens
  // configured. Queen is the only promotion-reachable type.
  const maxHealthApplies = (type: UnitType): boolean =>
    unitCount(type) > 0 || (type === "queen" && unitCount("pawn") > 0);

  const handleUnitCountChange = async (unitType: UnitType, value: number) => {
    const next: UnitCounts = {};
    UNIT_TYPES.forEach(({ type }) => {
      next[type] = type === unitType ? value : unitCount(type);
    });
    const total = totalUnitCount(next);
    if (total < 1 || total > MAX_UNITS_PER_TEAM) return;
    await updateDoc(gameDocRef, {
      unitsPerTeam: next,
      // Kept in sync with the snake count (minimum 1 for rules-compat); the
      // engine ignores snakesPerTeam when unitsPerTeam is present.
      snakesPerTeam: Math.max(1, next.snake ?? 0),
    });
    debouncedRegeneratePreview();
  };

  // Shared shape of the simple setup-field handlers: sanitize, mirror into
  // local state, write the one field, optionally regenerate the preview.
  // Plain factories (not hooks) so they can live beside the handlers below
  // the early returns; handlers were recreated per render before too.
  const setupNumberField = (
    name: string,
    {
      min = -Infinity,
      max = Infinity,
      round = (v: number) => v,
      regeneratesPreview = false,
      setLocal,
    }: {
      min?: number;
      max?: number;
      round?: (value: number) => number;
      regeneratesPreview?: boolean;
      setLocal?: (value: number) => void;
    },
  ) => {
    return async (raw: number) => {
      const sanitizedValue = Math.max(min, Math.min(max, round(raw)));
      setLocal?.(sanitizedValue);
      await updateDoc(gameDocRef, { [name]: sanitizedValue });
      if (regeneratesPreview) debouncedRegeneratePreview();
    };
  };

  const setupToggleField = (
    name: string,
    {
      regeneratesPreview = false,
      setLocal,
    }: {
      regeneratesPreview?: boolean;
      setLocal?: (value: boolean) => void;
    } = {},
  ) => {
    return async (enabled: boolean) => {
      setLocal?.(enabled);
      await updateDoc(gameDocRef, { [name]: enabled });
      if (regeneratesPreview) debouncedRegeneratePreview();
    };
  };

  const handlePawnPromotionWeightChange = setupNumberField("pawnPromotionWeight", {
    min: 2,
    max: 100,
    round: Math.round,
    setLocal: setPawnPromotionWeight,
  });

  // Per-unit-type max health. Same sanitize/mirror/write shape as
  // setupNumberField, but the setting is one key of the maxHealthPerUnit map
  // rather than a whole scalar field.
  const handleMaxHealthChange = async (unitType: UnitType, raw: number) => {
    const sanitizedValue = Math.max(1, Math.min(1000, Math.round(raw)));
    const next: UnitMaxHealth = { ...maxHealthPerUnit, [unitType]: sanitizedValue };
    setMaxHealthPerUnit(next);
    await updateDoc(gameDocRef, { maxHealthPerUnit: next });
  };

  // Handle max turns configuration (writes only while the limit is enabled,
  // so it stays hand-written)
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

  const handleHazardPercentageChange = setupNumberField("hazardPercentage", {
    min: 0,
    max: 100,
    regeneratesPreview: true,
    setLocal: setHazardPercentage,
  });

  // Damage only changes health accounting, not board layout: no preview regen.
  const handleHazardDamageChange = setupNumberField("hazardDamage", {
    min: 1,
    max: 1000,
    round: Math.round,
    setLocal: setHazardDamage,
  });

  const handleFertileGroundToggle = setupToggleField("fertileGroundEnabled", {
    regeneratesPreview: true,
    setLocal: setFertileGroundEnabled,
  });

  const handleFertileGroundDensityChange = setupNumberField("fertileGroundDensity", {
    min: 5,
    max: 80,
    regeneratesPreview: true,
    setLocal: setFertileGroundDensity,
  });

  const handleFertileGroundClusteringChange = setupNumberField("fertileGroundClustering", {
    min: 1,
    max: 20,
    regeneratesPreview: true,
    setLocal: setFertileGroundClustering,
  });

  const handleUsePreviewBoardChange = setupToggleField("usePreviewBoard");

  const handleFoodSpawnRateChange = setupNumberField("foodSpawnRate", {
    min: 0,
    max: 5,
    round: (v) => Math.round(v * 4) / 4,
    setLocal: setFoodSpawnRate,
  });

  const handleTeamClustersToggle = setupToggleField("teamClustersEnabled", {
    regeneratesPreview: true,
    setLocal: setTeamClustersEnabled,
  });

  const handleInvulnerabilityPotionToggle = setupToggleField(
    "invulnerabilityPotionEnabled",
    { setLocal: setInvulnerabilityPotionEnabled },
  );

  const handleInvulnerabilityPotionSpawnRateChange = setupNumberField(
    "invulnerabilityPotionSpawnRate",
    {
      min: 0.01,
      max: 0.2,
      round: (v) => Math.round(v * 100) / 100,
      setLocal: setInvulnerabilityPotionSpawnRate,
    },
  );

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

  const handleRemainingRoundsChange = setupNumberField("remainingRounds", {
    min: 0,
    round: Math.round,
    setLocal: setRemainingRounds,
  });

  const handleInterludeDurationChange = setupNumberField("interludeDuration", {
    min: 0,
    round: Math.round,
    setLocal: setInterludeDuration,
  });

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

  // Handle max turn time configuration (min 0.5s, max 5 minutes; the local
  // mirror is the text-field string)
  const handleSecondsPerTurnChange = setupNumberField("maxTurnTime", {
    min: 0.5,
    max: 300,
    setLocal: (v) => setSecondsPerTurn(`${v}`),
  });

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
  const boardFits = gameSetup.teams.length * totalUnits <= interiorCells;
  const canStartGame = enoughTeams && boardValid && turnTimeValid && boardFits;

  const teamValidationMessage = !enoughTeams
    ? gameSetup.teams.length === 0
      ? "Add centaurs to create teams before starting the game"
      : "At least 2 teams are needed before starting the game"
    : !boardFits
      ? "Board is too small for this many units — shrink the teams, lower units per team, or grow the board"
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
      </Box>

      {/* Game rules */}
      <SettingsPanel
        label="Rules"
        contentSx={{
          padding: 2,
          display: "flex",
          alignItems: "start",
          flexDirection: "column",
          fontFamily: "monospace",
          whiteSpace: "pre-wrap",
        }}
      >
        <TeamSnekRules />
      </SettingsPanel>
      {/* Tournament Mode */}
      <SettingsPanel
        label="Tournament Mode"
        contentSx={{
          padding: 2,
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
      </SettingsPanel>

      {/* Teams */}
      {/* Deliberate drift kept: this panel pads 1 where the others pad 2. */}
      <SettingsPanel label="Teams" contentSx={{ padding: 1 }}>
        <TeamList
          teams={gameSetup.teams}
          onColorChange={handleTeamColorChange}
          onRemove={handleRemoveTeam}
          disabled={started || isConfigDisabled}
          centaurStatuses={centaurStatuses}
          onRecheck={recheckCentaurHealth}
          recheckDisabled={started || isConfigDisabled}
        />
      </SettingsPanel>

      {/* Available Centaurs */}
      {centaurs.length > 0 && (
        <SettingsPanel
          label="Available Centaurs"
          labelSx={{ zIndex: 2 }}
          contentSx={{
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
              <CentaurPicker
                centaurs={centaurs}
                searchQuery={centaurSearchQuery}
                userID={userID}
                ownerNames={ownerNames}
                teams={gameSetup.teams}
                started={started}
                isConfigDisabled={isConfigDisabled}
                addingCentaur={addingCentaur}
                onAddCentaur={handleAddCentaur}
              />
            </Box>
        </SettingsPanel>
      )}

      {/* Snek Configuration */}
      <SettingsPanel label="Snek Configuration" contentSx={{ padding: 2 }}>
          <Box sx={isConfigDisabled ? { pointerEvents: 'none', opacity: 0.6 } : {}}>
            {/* Units per team */}
            <Box sx={{ mb: 1 }}>
              <Typography variant="body2" gutterBottom>
                Units per team ({totalUnits}/{MAX_UNITS_PER_TEAM})
              </Typography>
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                {UNIT_TYPES.map(({ type, label }) => (
                  <FormControl key={type} variant="outlined" size="small" sx={{ minWidth: 96 }}>
                    <InputLabel id={`units-per-team-${type}-label`}>{label}</InputLabel>
                    <Select
                      labelId={`units-per-team-${type}-label`}
                      value={unitCount(type)}
                      onChange={(event: SelectChangeEvent<number>) =>
                        handleUnitCountChange(type, Number(event.target.value))
                      }
                      disabled={started || isConfigDisabled}
                      label={label}
                    >
                      {UNIT_COUNT_OPTIONS.map((n) => {
                        const total = totalUnits - unitCount(type) + n;
                        return (
                          <MenuItem
                            key={n}
                            value={n}
                            disabled={total < 1 || total > MAX_UNITS_PER_TEAM}
                          >
                            {n}
                          </MenuItem>
                        );
                      })}
                    </Select>
                  </FormControl>
                ))}
              </Box>
              {unitCount("pawn") > 0 && (
                <TextField
                  label="Pawn promotion weight"
                  type="number"
                  size="small"
                  value={pawnPromotionWeight}
                  onChange={(e) => {
                    const value = parseInt(e.target.value);
                    if (!isNaN(value)) handlePawnPromotionWeightChange(value);
                  }}
                  disabled={started || isConfigDisabled}
                  sx={{ mt: 1.5, width: 200 }}
                  inputProps={{ min: 2, max: 100, step: 1 }}
                  helperText="A promoted queen restarts at weight 1"
                />
              )}
              {/* Max health, one small input per unit type in play. Queens
                  count as "in play" whenever pawns are, because a pawn
                  promotes into one. */}
              <Typography variant="body2" sx={{ mt: 1.5 }} gutterBottom>
                Max health (default 100)
              </Typography>
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
                {UNIT_TYPES.filter(({ type }) => maxHealthApplies(type)).map(
                  ({ type, label }) => {
                    const promotedOnly = type === "queen" && unitCount("queen") === 0;
                    return (
                      <TextField
                        key={type}
                        label={label}
                        type="number"
                        size="small"
                        value={maxHealthPerUnit[type] ?? ""}
                        placeholder="100"
                        onChange={(e) => {
                          const value = parseInt(e.target.value);
                          if (!isNaN(value)) handleMaxHealthChange(type, value);
                        }}
                        disabled={started || isConfigDisabled}
                        sx={{ width: promotedOnly ? 150 : 110 }}
                        inputProps={{ min: 1, max: 1000, step: 1 }}
                        helperText={promotedOnly ? "Promoted pawns" : undefined}
                      />
                    );
                  },
                )}
              </Box>
            </Box>
            <SnekConfiguration
              maxTurns={maxTurns}
              maxTurnsEnabled={maxTurnsEnabled}
              onMaxTurnsToggle={handleMaxTurnsToggle}
              onMaxTurnsChange={handleMaxTurnsChange}
              hazardPercentage={hazardPercentage}
              onHazardPercentageChange={handleHazardPercentageChange}
              hazardDamage={hazardDamage}
              onHazardDamageChange={handleHazardDamageChange}
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
              unitsPerTeam={gameSetup.unitsPerTeam}
            />
          </Box>
      </SettingsPanel>

      {/* Team Cluster */}
      <SettingsPanel
        label="Team Cluster"
        contentSx={{
          padding: 2,
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
      </SettingsPanel>

      {/* Invulnerability Potions */}
      <SettingsPanel
        label="(In)vulnerability Potions"
        contentSx={{
          padding: 2,
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
      </SettingsPanel>
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
