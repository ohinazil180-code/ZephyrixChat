# Zephyrix

A full-stack real-time messaging and calling web application built with React, Vite, Tailwind CSS, Express, WebSockets/SSE, PostgreSQL (`pg`), and SQLite (`node:sqlite`).

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
- **Backend**: Node.js (`>=22.18.0`), Express, `ws` (WebSockets) + Server-Sent Events (SSE), PostgreSQL (`pg` via `DATABASE_URL`) with automatic `node:sqlite` fallback
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
   - `DATABASE_URL` (optional PostgreSQL connection string — recommended for Render Free tier via Neon, Supabase, or Render Postgres so accounts/chats persist across restarts; omit locally to use SQLite automatically)
   - `DATA_DIR=./data` (SQLite database fallback and local uploads directory)
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

1. Create a new empty repository on [GitHub](https://github.com/new) (for example, `zephyrix`).
2. Run the included push helper script from the project root:
   ```bash
   chmod +x scripts/push-github.sh
   ./scripts/push-github.sh https://github.com/<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git
   ```
   Or run the Git commands directly:
   ```bash
   git init -b main
   git add .
   git commit -m "Initial commit: Zephyrix messaging app"
   git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git
   git push -u origin main
   ```

---

## Get Your Live GitHub Website URL

### Option A: Automatic GitHub Pages URL (`https://<username>.github.io/<repo>/`) + Render API

A GitHub Actions workflow is included to publish the frontend directly to **GitHub Pages** on every push to `main`:

1. Deploy the backend server to [Render](https://dashboard.render.com) via **New + -> Blueprint** using the included `render.yaml` file (this hosts the Express API, WebSocket/SSE stream, and SQLite database).
2. In Render **Environment**, set `FRONTEND_URL` to `https://<YOUR_GITHUB_USERNAME>.github.io` so cross-origin requests from GitHub Pages are allowed.
3. In your GitHub repository, open **Settings -> Secrets and variables -> Actions -> Variables** and create a variable named `VITE_API_URL` set to your Render URL (e.g. `https://<your-app>.onrender.com`).
4. In your GitHub repository, open **Settings -> Pages**, set **Source** to **GitHub Actions**, and re-run or push to `main`.
5. Your GitHub website is live at:
   `https://<YOUR_GITHUB_USERNAME>.github.io/<YOUR_REPO_NAME>/`

### Option B: Direct Full-Stack Render URL Linked on GitHub

1. Deploy the entire full-stack app to [Render](https://dashboard.render.com) using `render.yaml` (`npm install --include=dev && npm run build`, `npm start`, health check `/api/v1/health`).
2. Copy your live Render URL (`https://<your-app-name>.onrender.com`) or your GitHub Pages URL (`https://<YOUR_GITHUB_USERNAME>.github.io/<YOUR_REPO_NAME>/`).
3. On your GitHub repository page, click the gear icon next to **About**, paste your live URL into the **Website** field, and save.

