// src/pages/GamePage/components/GameSetup.tsx

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
import { Link } from "react-router-dom";
import { useUser } from "../../context/UserContext";
import { db, functions } from "../../firebaseConfig";
import { TeamConfiguration } from "../../components/TeamConfiguration";
import { SnekConfiguration } from "../../components/SnekConfiguration";
import { PlayerConfiguration } from "../../components/PlayerConfiguration";
import {
  BotHealthProvider,
  useBotHealth,
} from "../../context/BotHealthContext";

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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { GamePlayer, GameType, Team } from "@shared/types/Game";
import { useGameStateContext } from "../../context/GameStateContext";
import { getRulesComponent } from "./RulesDialog";

// Define the board size mapping
const BOARD_SIZE_MAPPING = {
  small: { width: 11, height: 11 },
  medium: { width: 13, height: 13 },
  large: { width: 17, height: 17 },
  giant: { width: 21, height: 21 },
};

type BoardSize = keyof typeof BOARD_SIZE_MAPPING;

// Curated set of visually-distinct, easy-to-name emojis used to give bot
// clones a recognisable per-game identity. Drawn at clone-creation time and
// stored on the GamePlayer entry so the choice is stable for the game.
const CLONE_EMOJI_POOL = [
  "🐶", "🐱", "🦊", "🐻", "🐯", "🐸", "🐙", "🐢", "🦄", "🐝",
  "🦋", "🐳", "🦖", "🐧", "🐔", "🦒", "🦘", "🐮", "🐷", "🐵",
  "🐰", "🦔", "🐌", "🐞", "🦀", "🐍", "🌵", "🍕", "🌈", "⚡",
];

function pickCloneEmoji(usedEmojis: Set<string>): string {
  const available = CLONE_EMOJI_POOL.filter((e) => !usedEmojis.has(e));
  const pool = available.length > 0 ? available : CLONE_EMOJI_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Short, URL-safe suffix used to disambiguate clone GamePlayer ids from the
// underlying bot id. Clone ids take the form `${botID}#${suffix}`, where the
// suffix keeps logs/IDs short while remaining collision-resistant.
function generateCloneSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

const GameSetup: React.FC = () => {
  const { userID, colour } = useUser();
  const {
    gameSetup,
    players,
    bots,
    gameType,
    setGameType,
    sessionName,
    gameID,
    gameState,
    session,
    isOwner,
  } = useGameStateContext();

  const hasOwner = session?.owner != null;
  const isConfigDisabled = hasOwner && !isOwner;

  const [secondsPerTurn, setSecondsPerTurn] = useState<string>("10");
  const [RulesComponent, setRulesComponent] = useState<React.FC | null>(null);
  const [boardSize, setBoardSize] = useState<BoardSize>("medium");
  const [teams, setTeams] = useState<Team[]>(gameSetup?.teams || []);
  const [botSearchQuery, setBotSearchQuery] = useState("");
  const [maxTurnsEnabled, setMaxTurnsEnabled] = useState<boolean>(
    gameSetup?.maxTurns !== undefined,
  );
  const [maxTurns, setMaxTurns] = useState<number>(gameSetup?.maxTurns ?? 100);
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

  const { getBotStatus } = useBotHealth();

  const [ownerNames, setOwnerNames] = useState<Record<string, string>>({});

  const ownerIDs = useMemo(
    () => Array.from(new Set(bots.map((b) => b.owner))),
    [bots],
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

  const isSnekGame = gameType === "snek" || gameType === "teamsnek" || gameType === "kingsnek";

  const requestCounterRef = useRef(0);
  const initialGenerationDoneRef = useRef(false);

  const firePreviewRequest = useCallback(async (shouldUncheck: boolean) => {
    if (!isSnekGame) return;
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
  }, [isSnekGame, sessionName, gameID]);

  const debouncedRegeneratePreview = useCallback(() => {
    if (!isSnekGame) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setIsGeneratingPreview(true);
    debounceTimerRef.current = setTimeout(() => {
      firePreviewRequest(true);
    }, 500);
  }, [firePreviewRequest, isSnekGame]);

  const immediateRegeneratePreview = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    firePreviewRequest(true);
  }, [firePreviewRequest]);

  useEffect(() => {
    if (!gameSetup || initialGenerationDoneRef.current) return;
    const isCurrentlySnekGame = gameSetup.gameType === "snek" || gameSetup.gameType === "teamsnek" || gameSetup.gameType === "kingsnek";
    if (!isCurrentlySnekGame) return;
    const hasPreviewData = gameSetup.presetFertileTiles || gameSetup.presetHazards || gameSetup.presetPlayerPositions || gameSetup.presetFood;
    if (!hasPreviewData) {
      initialGenerationDoneRef.current = true;
      firePreviewRequest(false);
    } else {
      initialGenerationDoneRef.current = true;
    }
  }, [gameSetup]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  // Inject the shake animation styles once the component mounts
  React.useEffect(() => {
    addStyles();
  }, []);

  // Update local state when gameSetup changes
  useEffect(() => {
    if (gameSetup) {
      // Update board size
      const currentSize = Object.entries(BOARD_SIZE_MAPPING).find(
        ([, dimensions]) =>
          dimensions.width === gameSetup.boardWidth &&
          dimensions.height === gameSetup.boardHeight,
      );
      if (currentSize) {
        setBoardSize(currentSize[0] as BoardSize);
      }

      // Update game type
      if (gameSetup.gameType) {
        setGameType(gameSetup.gameType);
      }

      // Update turn time
      setSecondsPerTurn(`${gameSetup.maxTurnTime}`);

      //  Update max turns
      if (gameSetup.maxTurns !== undefined) {
        setMaxTurns(gameSetup.maxTurns);
        setMaxTurnsEnabled(true);
      } else {
        setMaxTurnsEnabled(false);
      }

      // Update hazard percentage
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

      //  Update teams
      if (gameSetup.teams) {
        setTeams(gameSetup.teams);
      }
    }
  }, [gameSetup, setGameType]);

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

  useEffect(() => {
    setRulesComponent(() => getRulesComponent(gameSetup?.gameType));
  }, [gameSetup?.gameType, gameSetup]);

  if (!gameSetup) return null;

  // Start game
  const handleReady = async () => {
    await updateDoc(gameDocRef, {
      playersReady: arrayUnion(userID),
    });
  };

  const handleIncrementBotCount = async (botID: string) => {
    // Check if bot is dead before adding to game
    const botHealthStatus = getBotStatus(botID);
    if (botHealthStatus === "dead") {
      console.log(`Cannot add bot ${botID} to game - bot is dead`);
      return;
    }

    const bot = bots.find((b) => b.id === botID);
    if (!bot) {
      console.warn(`Bot ${botID} not found in available bots`);
      return;
    }

    const existingInstances = gameSetup.gamePlayers.filter(
      (p) => p.type === "bot" && (p.botRef === botID || p.id === botID),
    );

    let newInstance: GamePlayer;
    if (existingInstances.length === 0) {
      // First (original) instance: keep canonical id, no overrides
      newInstance = {
        id: botID,
        type: "bot",
      };
    } else {
      // Subsequent clone: synthesise a unique id and overrides
      const usedEmojis = new Set<string>(
        existingInstances
          .map((p) => p.displayEmoji)
          .filter((e): e is string => !!e),
      );
      usedEmojis.add(bot.emoji);
      const cloneEmoji = pickCloneEmoji(usedEmojis);
      newInstance = {
        id: `${botID}#${generateCloneSuffix()}`,
        type: "bot",
        botRef: botID,
        displayName: `${bot.name} ${existingInstances.length + 1}`,
        displayEmoji: cloneEmoji,
      };
    }

    await updateDoc(gameDocRef, {
      gamePlayers: arrayUnion(newInstance),
    });
    debouncedRegeneratePreview();
  };

  const handleDecrementBotCount = async (botID: string) => {
    // Find every gamePlayer entry pointing at this bot, in insertion order.
    const matchingIndexes: number[] = [];
    gameSetup.gamePlayers.forEach((p, idx) => {
      if (p.type !== "bot") return;
      const underlying = p.botRef ?? p.id;
      if (underlying === botID) matchingIndexes.push(idx);
    });

    if (matchingIndexes.length === 0) return;

    // Remove the most recently added instance (last in array order).
    const removeIdx = matchingIndexes[matchingIndexes.length - 1];
    const updatedGamePlayers = gameSetup.gamePlayers.filter(
      (_, idx) => idx !== removeIdx,
    );

    await updateDoc(gameDocRef, {
      gamePlayers: updatedGamePlayers,
    });
    debouncedRegeneratePreview();
  };

  // Start game
  const handleStart = async () => {
    await updateDoc(gameDocRef, {
      startRequested: true,
    });
  };

  const handlePlayerKick = async (playerID: string, _type: "bot" | "human") => {
    const updatedGamePlayers = gameSetup.gamePlayers.filter(
      (p) => p.id !== playerID
    );
    await updateDoc(gameDocRef, {
      gamePlayers: updatedGamePlayers,
    });
    debouncedRegeneratePreview();
  };

  // Handle team assignment for a player
  const handleTeamChange = async (playerID: string, teamID: string) => {
    if (!gameSetup) return;

    // Check if this is a dead bot trying to be assigned to a team
    const player = gameSetup.gamePlayers.find((p) => p.id === playerID);
    if (player?.type === "bot") {
      const botStatus = getBotStatus(playerID);
      if (botStatus === "dead") {
        console.log(`Cannot assign dead bot ${playerID} to team`);
        return;
      }
    }

    const updatedGamePlayers = gameSetup.gamePlayers.map((player) =>
      player.id === playerID ? { ...player, teamID } : player,
    );

    await updateDoc(gameDocRef, {
      gamePlayers: updatedGamePlayers,
    });
    debouncedRegeneratePreview();
  };

  // Handle team configuration changes
  const handleTeamsChange = async (newTeams: Team[]) => {
    await updateDoc(gameDocRef, {
      teams: newTeams,
    });
    setTeams(newTeams);
  };

  // Handle King selection for a player
  const handleKingToggle = async (playerID: string, teamID: string) => {
    if (!gameSetup) return;

    const updatedGamePlayers = gameSetup.gamePlayers.map((player) => {
      if (player.teamID === teamID) {
        return { ...player, isKing: player.id === playerID };
      }
      return player;
    });

    const teamPlayers = updatedGamePlayers.filter((p) => p.teamID === teamID);
    const kingPlayer = teamPlayers.find((p) => p.isKing);
    const otherPlayers = teamPlayers.filter((p) => !p.isKing);
    const nonTeamPlayers = updatedGamePlayers.filter(
      (p) => p.teamID !== teamID,
    );

    const reorderedPlayers = [
      ...(kingPlayer ? [kingPlayer] : []),
      ...otherPlayers,
      ...nonTeamPlayers,
    ];

    await updateDoc(gameDocRef, {
      gamePlayers: reorderedPlayers,
    });
    debouncedRegeneratePreview();
  };

  const handlePlayerTeamKick = async (playerID: string, teamID: string) => {
    if (!gameSetup) return;

    const playerIndex = gameSetup.gamePlayers.findIndex(
      (player: GamePlayer) =>
        player.id === playerID && player.teamID === teamID,
    );

    if (playerIndex === -1) {
      console.log("Player not found.");
      return;
    }

    //  Use null instead of deleteField()
    const updatedGamePlayers = gameSetup.gamePlayers.map((player, index) =>
      index === playerIndex
        ? { ...player, teamID: null } //  Set to null
        : player,
    );

    await updateDoc(gameDocRef, {
      gamePlayers: updatedGamePlayers,
    });
    debouncedRegeneratePreview();
  };

  // Handle max turns configuration
  const handleMaxTurnsChange = async (newMaxTurns: number) => {
    const sanitizedValue = Math.max(1, newMaxTurns);
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

  // Handler for selecting game type
  const handleGameTypeChange = async (event: SelectChangeEvent<GameType>) => {
    const selectedGameType = event.target.value as GameType;
    setGameType(selectedGameType);

    // Update Firestore when game type is selected
    if (!gameSetup?.started) {
      await updateDoc(gameDocRef, { gameType: selectedGameType });
    }
    const snekTypes = ["snek", "teamsnek", "kingsnek"];
    if (snekTypes.includes(selectedGameType)) {
      debouncedRegeneratePreview();
    }
  };

  // Handler for selecting board size
  const handleBoardSizeChange = async (event: SelectChangeEvent<BoardSize>) => {
    const selectedBoardSize = event.target.value as BoardSize;
    setBoardSize(selectedBoardSize);

    const { width, height } = BOARD_SIZE_MAPPING[selectedBoardSize];

    // Update Firestore when board size is selected
    if (!gameSetup?.started) {
      await updateDoc(gameDocRef, {
        boardWidth: width,
        boardHeight: height,
      });
    }
    debouncedRegeneratePreview();
  };

  if (gameState) return null;

  const { started, playersReady } = gameSetup;
  const notReadyPlayers = gameSetup.gamePlayers
    .filter((gamePlayer) => gamePlayer.type === "human")
    .filter((player) => !gameSetup.playersReady.includes(player.id))
    .map(
      (notReadyPlayer) =>
        players.find((player) => player.id === notReadyPlayer.id)?.name,
    );

  // Validation for Team Snek and King Snek games
  const canStartGame = () => {
    if (gameType !== "teamsnek" && gameType !== "kingsnek") return true;

    const populatedTeams = teams.filter((team) =>
      gameSetup.gamePlayers.some((player) => player.teamID === team.id),
    );

    if (populatedTeams.length < 2) return false;

    if (gameType === "kingsnek") {
      const teamsWithKing = populatedTeams.filter((team) =>
        gameSetup.gamePlayers.some(
          (player) => player.teamID === team.id && player.isKing,
        ),
      );
      return teamsWithKing.length === populatedTeams.length;
    }

    return true;
  };

  const getTeamValidationMessage = () => {
    if (gameType !== "teamsnek" && gameType !== "kingsnek") return "";

    const populatedTeams = teams.filter((team) =>
      gameSetup.gamePlayers.some((player) => player.teamID === team.id),
    );

    if (populatedTeams.length === 0) {
      return "Assign players to teams before starting the game";
    } else if (populatedTeams.length === 1) {
      return "At least 2 teams must have players before starting the game";
    }

    if (gameType === "kingsnek") {
      const teamsWithKing = populatedTeams.filter((team) =>
        gameSetup.gamePlayers.some(
          (player) => player.teamID === team.id && player.isKing,
        ),
      );
      if (teamsWithKing.length < populatedTeams.length) {
        return "Each team must have a King selected before starting the game";
      }
    }

    return "";
  };

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
      {/* Ready / Start / Tournament Section */}
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
          {!gameSetup.gamePlayers
            .filter((gamePlayer) => gamePlayer.type === "human")
            .map((human) => human.id)
            .every((player) => gameSetup.playersReady.includes(player)) ? (
            <>
              <Button
                disabled={
                  started ||
                  gameSetup.boardWidth < 5 ||
                  gameSetup.boardWidth > 25 ||
                  parseInt(secondsPerTurn) <= 0 ||
                  gameSetup.playersReady.includes(userID)
                }
                onClick={handleReady}
                sx={{ backgroundColor: colour, height: "70px", fontSize: "32px" }}
                fullWidth
              >
                {gameSetup.playersReady.includes(userID) ? `Waiting` : "I'm ready!"}
              </Button>
              {(gameType === "teamsnek" || gameType === "kingsnek") &&
                !canStartGame() &&
                getTeamValidationMessage() && (
                  <Typography color="error" sx={{ textAlign: "center", mt: 1 }}>
                    {getTeamValidationMessage()}
                  </Typography>
                )}
            </>
          ) : (
            <>
              <Button
                disabled={gameSetup.startRequested || !canStartGame() || isConfigDisabled}
                onClick={handleStart}
                sx={{
                  backgroundColor: canStartGame() ? colour : "#ccc",
                  height: "70px",
                  fontSize: "32px",
                  "&:hover": {
                    backgroundColor: canStartGame() ? colour : "#ccc",
                  },
                }}
                className={canStartGame() ? "shake" : ""}
                fullWidth
              >
                {gameSetup.startRequested ? "Game starting" : "Start game"}
              </Button>
              {!canStartGame() && getTeamValidationMessage() && (
                <Typography color="error" sx={{ textAlign: "center", mt: 1 }}>
                  {getTeamValidationMessage()}
                </Typography>
              )}
            </>
          )}
        </>
      )}
      {gameSetup.playersReady.includes(userID) &&
        notReadyPlayers.length > 0 && (
          <Typography color="error">
            Not ready: {notReadyPlayers.join(", ")}
          </Typography>
        )}
      <Box sx={{ display: "flex", gap: 2 }}>
        {/* Game Type Dropdown */}
        <FormControl variant="outlined" sx={{ flex: 1 }}>
          <InputLabel id="game-type-label">Game Type</InputLabel>
          <Select
            labelId="game-type-label"
            value={gameType}
            onChange={handleGameTypeChange}
            disabled={started || isConfigDisabled}
            label="Game Type"
          >
            <MenuItem value="snek">Snek</MenuItem>
            <MenuItem value="teamsnek">Team Snek</MenuItem>
            <MenuItem value="kingsnek">King Snek</MenuItem>
            <MenuItem value="connect4">Connect 4</MenuItem>
            <MenuItem value="tactictoes">Tactic Toes</MenuItem>
            <MenuItem value="longboi">Long Boi</MenuItem>
            <MenuItem value="reversi">Othello</MenuItem>
            <MenuItem value="colourclash">Colour Clash</MenuItem>
          </Select>
        </FormControl>

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
          </Select>
        </FormControl>

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
          {RulesComponent && <RulesComponent />}
          <FormControlLabel
            control={
              <Checkbox
                checked={gameSetup.skipConfirmation ?? false}
                onChange={async (e) => {
                  await updateDoc(gameDocRef, { skipConfirmation: e.target.checked });
                }}
                disabled={started || isConfigDisabled}
              />
            }
            label="Skip confirmation at game start"
          />
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
      {/* Bots List */}
      {bots.length > 0 && (
        <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
          <InputLabel shrink sx={{ backgroundColor: "white", px: 1, zIndex: 2 }}>
            Available Bots
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
                placeholder="Search bots..."
                value={botSearchQuery}
                onChange={(e) => setBotSearchQuery(e.target.value)}
                InputProps={{
                  endAdornment: botSearchQuery ? (
                    <InputAdornment position="end">
                      <IconButton
                        size="small"
                        onClick={() => setBotSearchQuery("")}
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
              const searchLower = botSearchQuery.toLowerCase();
              const filtered = botSearchQuery
                ? bots.filter((bot) => bot.name.toLowerCase().includes(searchLower))
                : bots;
              const grouped: Record<string, typeof bots> = {};
              filtered.forEach((bot) => {
                if (!grouped[bot.owner]) grouped[bot.owner] = [];
                grouped[bot.owner].push(bot);
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

              if (ownerOrder.length === 0 && botSearchQuery) {
                return (
                  <Typography sx={{ px: 2, py: 2, color: "#999", fontSize: "0.9rem" }}>
                    No bots match "{botSearchQuery}"
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
                    <Link
                      to={`/ladder/${ownerID}/${gameType}`}
                      style={{
                        fontSize: "0.8rem",
                        fontWeight: 600,
                        color: "#555",
                        textDecoration: "none",
                        cursor: "pointer",
                      }}
                      onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
                        e.currentTarget.style.textDecoration = "underline";
                      }}
                      onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
                        e.currentTarget.style.textDecoration = "none";
                      }}
                    >
                      {ownerID === userID
                        ? `${ownerNames[ownerID] || "You"} (You)`
                        : ownerNames[ownerID] || ownerID}
                    </Link>
                  </Box>
                  {grouped[ownerID].map((bot) => {
                    const botStatus = getBotStatus(bot.id);
                    const isDead = botStatus === "dead";
                    const instanceCount = gameSetup.gamePlayers.filter(
                      (p) =>
                        p.type === "bot" &&
                        ((p.botRef ?? p.id) === bot.id),
                    ).length;
                    const isInGame = instanceCount > 0;
                    const canIncrement = !isDead && !isConfigDisabled;
                    const canDecrement = instanceCount > 0 && !isConfigDisabled;

                    return (
                      <Box
                        key={bot.id}
                        title={
                          isDead
                            ? "Bot is dead and cannot be added to game"
                            : bot.name
                        }
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 1,
                          px: 2,
                          py: 1,
                          borderLeft: `4px solid ${isDead ? "#ccc" : bot.colour}`,
                          borderBottom: "1px solid #eee",
                          opacity: isDead ? 0.5 : 1,
                          backgroundColor: isDead ? "#f5f5f5" : "transparent",
                        }}
                      >
                        <Typography sx={{ fontSize: "1.2rem", flexShrink: 0 }}>
                          {bot.emoji}
                        </Typography>
                        <Typography
                          sx={{
                            fontWeight: 500,
                            flexGrow: 1,
                            wordBreak: "break-word",
                          }}
                        >
                          {bot.name}
                          {isDead && " (DEAD)"}
                          {isInGame && !isDead && " (IN GAME)"}
                        </Typography>
                        {!isDead && (
                          <Box
                            sx={{
                              display: "flex",
                              alignItems: "center",
                              gap: 0.5,
                              flexShrink: 0,
                            }}
                          >
                            <IconButton
                              size="small"
                              aria-label={`Remove one ${bot.name}`}
                              disabled={!canDecrement}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDecrementBotCount(bot.id);
                              }}
                              sx={{
                                border: "1px solid #999",
                                borderRadius: "4px",
                                width: 28,
                                height: 28,
                              }}
                            >
                              −
                            </IconButton>
                            <Typography
                              sx={{
                                minWidth: 20,
                                textAlign: "center",
                                fontVariantNumeric: "tabular-nums",
                                fontWeight: 600,
                              }}
                            >
                              {instanceCount}
                            </Typography>
                            <IconButton
                              size="small"
                              aria-label={`Add one ${bot.name}`}
                              disabled={!canIncrement}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleIncrementBotCount(bot.id);
                              }}
                              sx={{
                                border: "1px solid #999",
                                borderRadius: "4px",
                                width: 28,
                                height: 28,
                              }}
                            >
                              +
                            </IconButton>
                          </Box>
                        )}
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

      {(gameType === "snek" ||
        gameType === "teamsnek" ||
        gameType === "kingsnek") && (
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
                gamePlayers={gameSetup.gamePlayers}
                gameType={gameSetup.gameType}
                teams={gameSetup.teams}
              />
            </Box>
          </Box>
        </FormControl>
      )}

      {/* Team Cluster Configuration - Only show for team games */}
      {(gameType === "teamsnek" || gameType === "kingsnek") && (
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
      )}

      {/* Invulnerability Potions - Only show for team games */}
      {(gameType === "teamsnek" || gameType === "kingsnek") && (
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
      )}

      {/* Team Configuration - Only show for team games */}
      {(gameType === "teamsnek" || gameType === "kingsnek") && (
        <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
          <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
            Team Configuration
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
              <TeamConfiguration
                teams={teams}
                onTeamsChange={handleTeamsChange}
                bots={bots}
                gamePlayers={gameSetup?.gamePlayers || []}
              />
            </Box>
          </Box>
        </FormControl>
      )}

      {/* Players Table */}
      {(gameType === "teamsnek" || gameType === "kingsnek") &&
      teams.length > 0 ? (
        <FormControl fullWidth variant="outlined" sx={{ mt: 2 }}>
          <InputLabel shrink sx={{ backgroundColor: "white", px: 1 }}>
            Player Configuration
          </InputLabel>
          <Box
            sx={{
              border: "2px solid black",
              padding: 2,
              borderRadius: "0px",
              minHeight: "56px",
            }}
          >
            <PlayerConfiguration
              teams={teams}
              players={players}
              gamePlayers={gameSetup.gamePlayers}
              onTeamChange={handleTeamChange}
              onPlayerKick={handlePlayerKick}
              playersReady={playersReady}
              onPlayerTeamKick={handlePlayerTeamKick}
              getBotStatus={getBotStatus}
              gameType={gameType}
              onKingToggle={handleKingToggle}
              isOwner={isOwner}
              hasOwner={hasOwner}
              userID={userID}
            />
          </Box>
        </FormControl>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Player</TableCell>
                <TableCell align="right">Ready</TableCell>
                <TableCell align="right">Remove?</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {gameSetup.gamePlayers.map((gamePlayer) => {
                const player = players.find(
                  (player) => player.id === gamePlayer.id,
                );
                if (!player) return null;
                return (
                  <TableRow key={player.id}>
                    <TableCell sx={{ backgroundColor: player.colour }}>
                      {player.name} {player.emoji}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{ backgroundColor: player.colour }}
                    >
                      {playersReady.includes(player.id) ? "Yeah" : "Nah"}
                    </TableCell>
                    {(!hasOwner || isOwner) ? (
                      <TableCell
                        align="right"
                        sx={{ backgroundColor: player.colour }}
                        onClick={() =>
                          handlePlayerKick(player.id, gamePlayer.type)
                        }
                        style={{ cursor: "pointer" }}
                      >
                        ❌
                      </TableCell>
                    ) : (
                      <TableCell
                        align="right"
                        sx={{ backgroundColor: player.colour }}
                      />
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
};

const GameSetupWithProvider: React.FC = () => {
  return (
    <BotHealthProvider>
      <GameSetup />
    </BotHealthProvider>
  );
};

export default GameSetupWithProvider;

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
