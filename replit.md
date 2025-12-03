# Overview

Tactic Toes is a multiplayer game platform built with React/TypeScript frontend and Firebase Functions backend. The platform supports multiple game types including Snake (snek), Team Snake (teamsnek), King Snake (kingsnek), Connect 4, Longboi, Tic-tac-toes (tactictoes), Color Clash, and Reversi. Games can be played in real-time with both human players and AI bots, featuring simultaneous turn-based gameplay where conflicts are resolved through "clashes." The system includes MMR-based rankings, session management, and comprehensive game state synchronization.

# Recent Changes

## First Turn Time Configuration & Setup Cloning (November 12, 2025)
- **Problem Solved**: Fixed timing mismatch where turn 0 had a hardcoded 60-second endTime but expired after 10 seconds (using maxTurnTime)
- **New Field**: Added optional `firstTurnTime` field to GameSetup (defaults to 60 seconds)
- **Backward Compatibility**: Field is optional with nullish coalescing (?? 60) in all read paths to handle legacy setups
- **General Setup Cloning**: Refactored `createNewGame` to use object spreading - automatically copies ALL setup fields (including future custom fields) from previous game, only resetting per-game state (playersReady, startRequested, started, timeCreated)
- **Rematch Flow**: `gamePlayers` array is preserved between games, maintaining bots, king designations, and team assignments; players must re-ready to start new game
- **Core Changes**:
  - `onGameStarted` now uses `firstTurnTime` for both turn 0 endTime and task scheduling
  - `createNewGame` uses spread operator (`...previousSetup`) to preserve all configuration including player roster across game iterations
  - Firestore rules validate `firstTurnTime` as optional positive integer
- **Deployment Safety**: Legacy GameSetup documents without firstTurnTime automatically default to 60 seconds
- **Enhanced Logging**: Added comprehensive [onGameStarted], [onMoveCreated], [processTurnExpirationTask] log prefixes for debugging turn progression
- **Future-Proof**: New custom fields added to GameSetup will automatically carry over to subsequent games without code changes

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

# Infrastructure & Deployment

## GCP Project Bootstrap Script

**Location**: `scripts/bootstrap-gcp-project.sh`

When setting up a new Firebase/GCP project (e.g., a new staging environment), run this script to configure all required APIs and IAM permissions in one step:

```bash
./scripts/bootstrap-gcp-project.sh <PROJECT_ID>
```

**IMPORTANT: Maintaining This Script**

The Firebase CLI does NOT automatically grant IAM permissions when deploying. If you add new GCP/Firebase features to this project, you MUST update the bootstrap script to include any new required permissions. Otherwise, future deployments to new environments will fail with permission errors that require time-consuming troubleshooting.

**When to update the script:**
- Adding a new Firebase service (e.g., Storage, Realtime Database)
- Using a new Google Cloud API (e.g., Vision API, Translate API)
- Adding new Cloud Functions that require additional permissions
- Changing from Gen1 to Gen2 Functions (different service accounts)
- Adding Secret Manager secrets
- Adding new Cloud Tasks queues or Pub/Sub topics

**Current GCP resources requiring permissions:**
- Firebase Functions (Gen1 and Gen2)
- Firestore
- Firebase Hosting
- Firebase Auth
- Google Cloud Tasks (turn-expiration-queue)
- Artifact Registry (for function container images)
- Cloud Build (for function deployment)
- Cloud Logging
- Pub/Sub (for Eventarc triggers)
- Cloud Run (for Gen2 functions)

## Organization Policy: Domain Restricted Sharing

**Problem:** If your GCP project is under an organization with Domain Restricted Sharing enabled (`iam.allowedPolicyMemberDomains`), Firebase callable functions will fail with CORS errors. This is because:

1. Firebase callable functions (like `wakeBot`) need `allUsers` to have the Cloud Functions Invoker role
2. The organization policy blocks granting permissions to `allUsers` (anyone on the internet)
3. GCP IAM and Firebase Auth are separate systems - even though users authenticate with Firebase, the browser request must first be allowed at the GCP IAM layer

**Symptoms:**
- CORS errors when calling callable functions from the browser
- Error message: "User allUsers is not in permitted organization"
- Bot health checks fail immediately

**Solution:** Remove the domain restriction at the organization level:

```bash
# Find your organization ID
gcloud organizations list

# Remove the restriction (replace ORG_ID with your org number)
gcloud org-policies delete iam.allowedPolicyMemberDomains --organization=ORG_ID

# Wait up to 15 minutes for propagation, then grant public access
gcloud functions add-iam-policy-binding wakeBot \
  --region=us-central1 \
  --member=allUsers \
  --role=roles/cloudfunctions.invoker \
  --project=PROJECT_ID
```

**Security Note:** This allows the HTTP request to reach the function, but the function code still validates Firebase Auth tokens via `context.auth`. The `allUsers` permission is at the network layer, not the application layer.

**Firebase Project Aliases** (defined in `.firebaserc`):
- `production`: tactic-toes-tuke (live production environment)
- `staging`: tactic-toes-cyphid-dev (development/testing environment)

## Environment-Specific Configuration

Frontend Firebase config is determined by environment variables. See `frontend/src/firebaseConfig.ts` for the configuration loading logic. Set the following environment variables in Replit for staging development:
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`