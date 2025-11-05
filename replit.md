# Overview

Tactic Toes is a multiplayer game platform built with React/TypeScript frontend and Firebase Functions backend. The platform supports multiple game types including Snake (snek), Team Snake (teamsnek), King Snake (kingsnek), Connect 4, Longboi, Tic-tac-toes (tactictoes), Color Clash, and Reversi. Games can be played in real-time with both human players and AI bots, featuring simultaneous turn-based gameplay where conflicts are resolved through "clashes." The system includes MMR-based rankings, session management, and comprehensive game state synchronization.

# Recent Changes

## Turn Processing Architecture Refactor (November 5, 2025)
- **Problem Solved**: Eliminated race condition where task scheduling inside Firestore transactions could create duplicate tasks on retry, and where post-transaction operations could fire before commits
- **Architecture Pattern**: Moved from trigger-based task scheduling to caller-orchestrated post-transaction operations
- **New Components**:
  - `processTurnExpirationTask`: Firebase task queue function (v2/tasks) that processes turn expirations
  - `notifyBots`: Standalone utility function for sending bot move requests via Battlesnake API
  - `ProcessTurnResult`: Interface returned by processTurn with metadata for post-transaction orchestration
- **Core Changes**:
  - `processTurn` now returns metadata (newTurnCreated, turnNumber, duration) instead of scheduling tasks directly
  - Callers (`onMoveCreated`, `processTurnExpirationTask`) schedule tasks and call bot notifications AFTER transactions commit
  - Eliminated all Cloud Task queue utilities and their Firestore trigger wrappers
- **Reliability Improvements**: Transaction retries no longer create duplicate scheduled tasks; bot notifications always see committed state
- **Removed**: `scheduleTurnExpiration`, `scheduleBotNotifications`, `onTurnExpirationRequest`, `onBotNotificationRequest` triggers

## King Snake Game Mode (October 7, 2025)
- **New Game Type**: Added "King Snake" (kingsnek) - a team-based battlesnake variant where each team has one designated King
- **Game Rules**: When a King dies, their entire team is eliminated and team score is set to zero; team score is based solely on the King's snake length
- **Visual Indicators**: King snakes display a crown emoji (👑) instead of their regular emoji during gameplay
- **Bot Integration**: Bots receive King information via API to implement King-focused strategies
- **UI Features**: Added crown checkbox for King selection during game setup; Kings automatically move to first position in team list

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React 18 with TypeScript and Vite for fast development and building
- **State Management**: Context API with custom providers for user authentication, game state, and ladder rankings
- **UI Framework**: Material-UI (MUI) v6 with custom theming and Roboto Mono font
- **Routing**: React Router DOM for client-side navigation
- **Real-time Updates**: Firebase SDK with Firestore listeners for live game state synchronization
- **Styling**: Emotion-based styling with custom components and animations

## Backend Architecture
- **Runtime**: Firebase Functions with Node.js 18
- **Database**: Firestore for real-time document storage with offline support via emulators
- **Authentication**: Firebase Auth with anonymous sign-in and Google OAuth integration
- **Background Jobs**: Google Cloud Tasks for scheduled turn expirations and bot move processing
- **Game Logic**: Modular processor pattern with abstract base class and game-specific implementations
- **API Integration**: Battlesnake API support for external bot integration

## Game Engine Design
- **Turn-based System**: Simultaneous moves with conflict resolution through "clashes"
- **State Management**: Immutable game states stored as Firestore documents with turn-by-turn progression
- **Real-time Synchronization**: Client-side listeners maintain live game state without polling
- **Bot Integration**: Supports both internal bots and external Battlesnake API bots
- **MMR System**: Elo-based rating system with placement-based calculations and K-factor adjustments for new players

## Data Architecture
- **Sessions**: Top-level containers for games with automatic game creation
- **Games**: Individual game instances with setup, state, and turn history
- **Rankings**: Per-player MMR tracking across different game types
- **Move Tracking**: Atomic move submissions with validation and expiration handling
- **Team Support**: Configurable team-based gameplay with shared objectives

# External Dependencies

## Firebase & Google Cloud
- **Firebase Firestore**: Primary database for real-time game state, user data, and rankings
- **Firebase Functions**: Serverless backend for game logic, turn processing, and bot integration
- **Firebase Auth**: User authentication with anonymous and Google sign-in
- **Firebase Hosting**: Static site hosting with SPA routing support
- **Google Cloud Tasks**: Scheduled job processing for turn timeouts and bot moves
- **Google Cloud Logging**: Centralized logging and monitoring

## Frontend Libraries
- **@mui/material**: Comprehensive React component library with theming
- **react-router-dom**: Client-side routing and navigation
- **react-color**: Color picker components for user customization
- **lucide-react**: Icon library for UI elements
- **tinycolor2**: Color manipulation utilities

## Development Tools
- **TypeScript**: Static typing across frontend and backend
- **ESLint**: Code quality and consistency enforcement
- **Jest**: Unit testing framework with Firebase Functions test utilities
- **Vite**: Fast frontend build tool with HMR support
- **Firebase CLI**: Local development with emulator suite

## External APIs
- **Battlesnake API**: Integration for external bot players with standard move/game endpoints
- **Google OAuth**: Social authentication for user accounts