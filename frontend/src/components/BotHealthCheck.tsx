import React, { useEffect, useRef } from "react";
import {
  Box,
  Typography,
  Chip,
  CircularProgress,
  Button,
} from "@mui/material";
import { Bot } from "@shared/types/Game";
import { useBotHealth, BotStatus } from "../context/BotHealthContext";

interface BotHealthCheckProps {
  bots: Bot[];
  gamePlayers: Array<{ id: string; type: "bot" | "human"; teamID?: string }>;
  autoCheck?: boolean; // Whether to automatically check bots when they're added
  showTitle?: boolean; // Whether to show the "Bot Health Check" title
  compact?: boolean; // Whether to show in compact mode
}

export const BotHealthCheck: React.FC<BotHealthCheckProps> = ({
  bots,
  gamePlayers,
  autoCheck = true,
  showTitle = true,
  compact = false,
}) => {
  const { botHealthStatus, checkBotHealth, checkAllBotsHealth, isCheckingBots, getBotStatus } = useBotHealth();
  const checkedBotsRef = useRef<Set<string>>(new Set());

  // Automatically check bot health when bots are added to the game
  useEffect(() => {
    if (!autoCheck) return;
    
    const botsInGame = bots.filter(bot => 
      gamePlayers.some(gp => gp.id === bot.id && gp.type === 'bot')
    );
    
    if (botsInGame.length > 0) {
      // Check each bot individually when added (only once)
      botsInGame.forEach(bot => {
        const currentStatus = getBotStatus(bot.id);
        const hasBeenChecked = checkedBotsRef.current.has(bot.id);
        
        if (currentStatus === 'unknown' && !hasBeenChecked) {
          console.log(`Auto-checking bot ${bot.name} for the first time`);
          checkedBotsRef.current.add(bot.id);
          checkBotHealth(bot);
        }
      });
    }
  }, [gamePlayers, bots, autoCheck, checkBotHealth, getBotStatus]);

  // Get bot status chip color
  const getBotStatusColor = (status: BotStatus) => {
    switch (status) {
      case 'alive': return 'success';
      case 'dead': return 'error';
      case 'error': return 'warning';
      case 'loading': return 'info';
      case 'unknown': return 'default';
      default: return 'default';
    }
  };

  // Get bot status text
  const getBotStatusText = (status: BotStatus) => {
    switch (status) {
      case 'alive': return 'Alive';
      case 'dead': return 'Dead';
      case 'error': return 'Error';
      case 'loading': return 'Loading...';
      case 'unknown': return 'Unknown';
      default: return 'Unknown';
    }
  };

  const botsInGame = bots.filter(bot => 
    gamePlayers.some(gp => gp.id === bot.id && gp.type === 'bot')
  );

  if (botsInGame.length === 0) {
    return null; // Don't render if no bots in game
  }

  return (
    <Box sx={{ mt: compact ? 2 : 3, mb: compact ? 2 : 3 }}>
      {showTitle && (
        <Typography variant="h6" sx={{ mb: 2 }}>
          Bot Health Check
        </Typography>
      )}
      
      {!compact && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 2 }}>
          <Button
            variant="contained"
            onClick={() => checkAllBotsHealth(bots, gamePlayers)}
            disabled={isCheckingBots}
            sx={{
              backgroundColor: '#1976d2',
              '&:hover': {
                backgroundColor: '#1565c0'
              }
            }}
          >
            {isCheckingBots ? (
              <>
                <CircularProgress size={20} sx={{ mr: 1 }} />
                Checking...
              </>
            ) : (
              'Check Bot Health'
            )}
          </Button>
          
          {isCheckingBots && (
            <Typography variant="body2" color="text.secondary">
              Checking bot health...
            </Typography>
          )}
        </Box>
      )}

      {/* Bot Status Display */}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
        {botsInGame.map((bot) => {
          const status = getBotStatus(bot.id);
          return (
            <Box
              key={bot.id}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                p: compact ? 0.5 : 1,
                border: compact ? "none" : "1px solid #e0e0e0",
                borderRadius: 1,
                backgroundColor: compact ? "transparent" : "#f5f5f5",
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {bot.emoji} {bot.name}
              </Typography>
              <Chip
                label={getBotStatusText(status)}
                color={getBotStatusColor(status)}
                size="small"
                icon={status === 'loading' ? <CircularProgress size={16} /> : undefined}
              />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
