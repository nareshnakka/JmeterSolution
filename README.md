# JMeter Agent Server

A lightweight, self-hosted JMeter test management and execution server for Windows — similar in spirit to Performance Center, but simple enough to run on a single machine.

## Features

- **Release → Build → Application** hierarchy for organizing test assets
- Upload JMX scripts, CSV dependencies, and additional files per application
- **Ad-hoc** and **scheduled** test execution (non-GUI / `-n` mode)
- **Live monitoring dashboard** with active users graph, transaction metrics table (aggregate-report style), per-transaction graphs, and error feed
- Browse test artifacts (JTL, logs, reports) directly on the server filesystem
- Tag and name scenarios for easy tracking across releases
- **Comparison dashboard** — select multiple test runs by ID or release/build
- Export test details (format configurable)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  React Frontend (Vite)                                      │
│  - Release/Build/App browser  - Live dashboard (WebSocket)  │
│  - Schedule manager           - Comparison view             │
└──────────────────────────┬──────────────────────────────────┘
                           │ REST + WebSocket
┌──────────────────────────▼──────────────────────────────────┐
│  FastAPI Backend                                            │
│  - CRUD: releases, builds, apps, scenarios, test runs       │
│  - File uploads → data/{release}/{build}/{app}/             │
│  - APScheduler for scheduled runs                           │
│  - JMeter subprocess manager (localhost)                    │
│  - JTL tail parser → live metrics aggregator                │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Apache JMeter (non-GUI)  +  data/ artifact store           │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

- **Windows Server** (or Windows 10/11)
- **Python 3.11+**
- **Node.js 18+** (for frontend build)
- **Apache JMeter 5.x** installed and `JMETER_HOME` set

## Quick Start

### 1. Configure environment

Copy `.env.example` to `.env` and set paths:

```env
JMETER_HOME=C:\apache-jmeter-5.6.3
DATA_ROOT=D:\JmeterAgent-Server\data
DATABASE_URL=sqlite:///./jmeter_agent.db
```

### 2. Backend

```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

### 3. Frontend (development)

```powershell
cd frontend
npm install
npm run dev
```

### 4. Production (single service)

Build the frontend and serve via FastAPI:

```powershell
cd frontend && npm run build
cd ..\backend
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

Open `http://localhost:8080`.

## Directory Layout (data store)

```
data/
  {release}/
    {build}/
      {application}/
        scripts/       ← JMX scripts and CSV / dependency files (same folder)
        uploads/       ← additional optional files
        runs/
          {run_id}/
            results.jtl
            jmeter.log
            report/
```

## API Overview

| Endpoint | Description |
|----------|-------------|
| `GET/POST /api/releases` | Manage releases |
| `GET/POST /api/releases/{id}/builds` | Manage builds |
| `GET/POST /api/builds/{id}/applications` | Manage applications |
| `POST /api/applications/{id}/scenarios` | Upload JMX + tag scenario |
| `POST /api/scenarios/{id}/files` | Upload CSV / dependency files |
| `POST /api/test-runs` | Start ad-hoc test |
| `POST /api/test-runs/schedule` | Schedule a test |
| `GET /api/test-runs/{id}` | Run status + artifact paths |
| `WS /ws/test-runs/{id}` | Live metrics stream |
| `GET /api/test-runs/compare` | Comparison data for selected runs |

## Live Metrics

While a test runs, the backend tails `results.jtl` and aggregates:

- Active threads (from `<threadName>` groups)
- Per-label: samples, avg/min/max, throughput, error %
- Error samples with response message and exception details
- Time-series buckets for graphing (configurable interval, default 5 s)

## Windows Service (optional)

Use `scripts/install-service.ps1` to register as a Windows service via NSSM.

## License

MIT
