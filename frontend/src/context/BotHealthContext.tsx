import React, { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { Bot } from "@shared/types/Game";

export type BotStatus = 'unknown' | 'loading' | 'alive' | 'dead' | 'error';

interface BotHealthStatus {
  [botId: string]: BotStatus;
}

interface BotHealthContextType {
  botHealthStatus: BotHealthStatus;
  checkBotHealth: (bot: Bot) => Promise<void>;
  checkAllBotsHealth: (bots: Bot[], gamePlayers: Array<{ id: string; type: "bot" | "human" }>) => Promise<void>;
  isCheckingBots: boolean;
  getBotStatus: (botId: string) => BotStatus;
}

const BotHealthContext = createContext<BotHealthContextType | undefined>(undefined);

interface BotHealthProviderProps {
  children: ReactNode;
}

export const BotHealthProvider: React.FC<BotHealthProviderProps> = ({ children }) => {
  const [botHealthStatus, setBotHealthStatus] = useState<BotHealthStatus>({});
  const [isCheckingBots, setIsCheckingBots] = useState(false);

  // Bot health check function using HTTP request
  const checkBotHealth = useCallback(async (bot: Bot): Promise<void> => {
    // Don't check if already checking or recently checked
    const currentStatus = botHealthStatus[bot.id];
    if (currentStatus === 'loading') {
      console.log(`Bot ${bot.name} is already being checked, skipping`);
      return;
    }

    // Set loading state immediately
    setBotHealthStatus(prev => ({
      ...prev,
      [bot.id]: 'loading'
    }));

    try {
    
      console.log(`Checking bot ${bot.name} health at: ${bot.url}`);
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(bot.url)}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(proxyUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      console.log(`Bot ${bot.name} response: ${response.status}`);
      
      clearTimeout(timeoutId);
      
      if (response.ok) {
        const text = await response.text();
        console.log(`Bot ${bot.name} response length: ${text.length}`);
        
        // Check if the response contains typical bot error indicators
        if (text.includes('error') || text.includes('dead') || text.includes('not found') || text.length < 10) {
          console.log(`Bot ${bot.name} marked as DEAD`);
          setBotHealthStatus(prev => ({
            ...prev,
            [bot.id]: 'dead'
          }));
        } else {
          console.log(`Bot ${bot.name} marked as ALIVE`);
          setBotHealthStatus(prev => ({
            ...prev,
            [bot.id]: 'alive'
          }));
        }
      } else {
        console.log(`Bot ${bot.name} HTTP error: ${response.status}`);
        setBotHealthStatus(prev => ({
          ...prev,
          [bot.id]: 'dead'
        }));
      }
      
    } catch (error) {
      console.error(`Bot ${bot.name} health check failed:`, error);
      setBotHealthStatus(prev => ({
        ...prev,
        [bot.id]: 'error'
      }));
    }
  }, [botHealthStatus]);

  // Check all bots health
  const checkAllBotsHealth = useCallback(async (bots: Bot[], gamePlayers: Array<{ id: string; type: "bot" | "human" }>): Promise<void> => {
    const botsInGame = bots.filter(bot => 
      gamePlayers.some(gp => gp.id === bot.id && gp.type === 'bot')
    );
    
    if (botsInGame.length === 0) return;
    
    setIsCheckingBots(true);
    
    // Check each bot health
    const healthChecks = botsInGame.map(bot => checkBotHealth(bot));
    
    await Promise.all(healthChecks);
    setIsCheckingBots(false);
  }, [checkBotHealth]);

  // Get bot status
  const getBotStatus = useCallback((botId: string): BotStatus => {
    return botHealthStatus[botId] || 'unknown';
  }, [botHealthStatus]);

  const value: BotHealthContextType = {
    botHealthStatus,
    checkBotHealth,
    checkAllBotsHealth,
    isCheckingBots,
    getBotStatus,
  };

  return (
    <BotHealthContext.Provider value={value}>
      {children}
    </BotHealthContext.Provider>
  );
};

export const useBotHealth = (): BotHealthContextType => {
  const context = useContext(BotHealthContext);
  if (context === undefined) {
    throw new Error('useBotHealth must be used within a BotHealthProvider');
  }
  return context;
};
