# Zephyrix

A full-stack real-time messaging and calling web application built with React, Vite, Tailwind CSS, Express, WebSockets/SSE, and SQLite (`node:sqlite`).

## Features

- **Direct Chats, Groups, Broadcast Channels & Saved Messages**: Role-based group and channel moderation (`owner`, `admin`, `member`), invite-code joining, pinned conversations, archive/mute preferences, and typing/read indicators.
- **Rich Messaging Actions**:
  - Threaded replies with clickable jump-to-original highlight and private DM replies (`Reply Privately`) from groups/channels.
  - Multi-message selection mode with checkboxes and bottom action bar to forward multiple messages in chronological order to multiple chats or contacts.
  - Dual-scope message deletion: **Delete for me** (persisted per user) and **Delete for everyone** (authorized for the original sender plus group/channel owners and admins).
  - Emoji reaction trays and hover/focus reaction tooltips showing who reacted.
- **Media, Voice Notes & Lightbox Preview**: Image, video, voice note recording, and document attachments with inline PDF, formatted text, JSON, and Markdown preview.
- **AI Assistant & Bot Support**: Server-side Gemini integration via `@google/genai` and configurable chat bots.
- **HD Audio / Video / Group Calling**: ZEGOCLOUD UIKit & ZIM signaling with server-side Token04 minting.
- **Bilingual UI & PWA**: English & Bengali (`bn`) localization, Dark Glass & Light themes, offline outbox queuing, and installable PWA support.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4, Lucide Icons, Motion
- **Backend**: Node.js (`>=22.18.0`), Express, `ws` (WebSockets) + Server-Sent Events (SSE), `node:sqlite`
- **Deployment**: Included `render.yaml` Blueprint for Render Web Service hosting

## Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment variables**:
   Copy `.env.example` to `.env` and fill in your values (never commit `.env` to Git):
   ```bash
   cp .env.example .env
   ```
   Key variables:
   - `PORT=3000`
   - `SESSION_PEPPER` (32+ random characters in production)
   - `DATA_DIR=./data` (SQLite database and local uploads directory)
   - `GEMINI_API_KEY` (optional, for AI assistant replies)
   - `ZEGO_APP_ID` and `ZEGO_SERVER_SECRET` (optional, for live ZEGOCLOUD audio/video calls)

3. **Start the development server**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000`.

4. **Build and run in production**:
   ```bash
   npm run build
   npm start
   ```

---

## Push This Project to GitHub

`.gitignore` is already configured to exclude `node_modules/`, `dist/`, `dev-dist/`, `data/`, `uploads/`, `*.db*`, and `.env*` secrets so only clean source code is committed.

1. Create a new empty repository on [GitHub](https://github.com/new) (for example, `zephyrix-chat`) without initializing a README or license on GitHub.
2. Run these commands from the project root directory:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: Zephyrix messaging app"
   git branch -M main
   git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git
   git push -u origin main
   ```

---

## Create a Live Website Link (Render + GitHub Repository Website URL)

Because Zephyrix runs an Express backend, SQLite database, and WebSocket/SSE real-time server, it requires a Node.js web host rather than static-only GitHub Pages. A `render.yaml` blueprint is already included for one-click deployment:

1. Sign in to [Render](https://dashboard.render.com) with your GitHub account.
2. Click **New +** -> **Blueprint** and select your pushed GitHub repository.
3. Render reads `render.yaml` automatically (`npm ci && npm run build`, `npm start`, health check `/api/v1/health`).
4. Add your optional environment secrets (`GEMINI_API_KEY`, `ZEGO_APP_ID`, `ZEGO_SERVER_SECRET`) in the Render service **Environment** tab (`SESSION_PEPPER` is auto-generated).
5. Once deployed, copy your live Render URL (e.g. `https://<your-app-name>.onrender.com`).
6. Open your GitHub repository page, click the gear icon next to **About** on the right sidebar, paste your live URL into the **Website** field, and save. Your GitHub repository now displays a direct clickable link to your live Zephyrix web app.
