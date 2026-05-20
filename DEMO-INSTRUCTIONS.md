# Content Scout Demo Instructions

This guide walks you through a full demo of Content Scout, showing both the agent chat and web UI surfaces. Use this to showcase feature parity and workflow clarity.

---

## 1. Agent Surface (VS Code / Copilot Chat / AI Chat)

### 1.1 Onboarding (if not already configured)
- **Command:** `/scout-onboard`
- **Flow:**
  1. Choose setup tier (Quick/Standard/Full)
  2. Answer product, role, and network questions (one per turn)
  3. Confirm or edit Smart Suggestions
  4. Finish and save config

### 1.2 Run a Content Scan
- **Command:** `/scout-scan` (or `/scout-scan azure-cosmos-db`)
- **What happens:**
  - Scans all configured sources (X, LinkedIn, Reddit, blogs, YouTube, GitHub, etc.)
  - Applies quality filters, deduplication, and topic tagging
  - Ingests browser-scan Layer 0 if available
  - Writes a report to `reports/{timestamp}-azure-cosmos-db-content.md`

### 1.3 Generate Social Posts
- **Command:** `/scout-post`
- **Inputs:**
  - URL, report item number, or source copy
  - Platform preference (LinkedIn, X, etc.)
- **What happens:**
  - Generates at least 3 LinkedIn and 3 X post options per item
  - Writes to `social-posts/{timestamp}-azure-cosmos-db-social-posts.md`

### 1.4 Create a Posting Calendar
- **Command:** `/scout-calendar`
- **Inputs:**
  - Report to use (latest by default)
  - Number of weeks (default: 2)
- **What happens:**
  - Spreads posts across days/platforms
  - Writes to `social-posts/{timestamp}-azure-cosmos-db-posting-calendar.md`

### 1.5 Run Gap, Trends, and Creators Analysis
- **Commands:** `/scout-gaps`, `/scout-trends`, `/scout-creators`
- **What happens:**
  - Gap: Shows topics with no recent coverage
  - Trends: Month-over-month content and sentiment trends
  - Creators: Surfaces rising, stable, fading, and detractor creators

### 1.6 Health Check
- **Command:** `/scout-doctor`
- **What happens:**
  - Validates config, API keys, and persistent state
  - Reports any issues or missing keys

---

## 2. Web UI Surface (`tools/web-ui/`)

### 2.1 Start the Web UI
- **Command:** `node tools/web-ui/server.js`
- **Open:** [http://localhost:4477](http://localhost:4477)

### 2.2 Visual Features
- **Dashboards:** Sentiment summary, source health, action items, authors view
- **Bulk Operations:** Multi-subject scan via CSV, bulk close/reopen, muted account import
- **Live Run Streaming:** Real-time log panel for `/scout-*` commands
- **Visual Triage:** Conversations panel with bulk-select, mentions browser, muted-accounts manager
- **Drag-and-Drop:** Image upload for alt text, CSV upload for bulk runs
- **Guided Pickers:** Model browser, `.env` editor

### 2.3 Parity Note
- All standard content-creating operations (scan, post, calendar, gaps, trends, creators, doctor) are available via the agent.
- The web UI is for dashboards, bulk ops, and visual triage only.

---

## 3. Demo Flow Example

1. **Onboard a new product** (if needed) via `/scout-onboard`.
2. **Run a scan** with `/scout-scan` and show the generated report in `reports/`.
3. **Generate social posts** for a report item with `/scout-post` and show the output in `social-posts/`.
4. **Create a posting calendar** with `/scout-calendar` and show the output file.
5. **Show gaps, trends, and creators** with `/scout-gaps`, `/scout-trends`, `/scout-creators`.
6. **Run `/scout-doctor`** to demonstrate health checks.
7. **Switch to the web UI** and show dashboards, bulk scan, and visual triage features.

---

**Tip:** Emphasize that all value-creating work can be done from the agent, and the web UI is for advanced/visual workflows.
