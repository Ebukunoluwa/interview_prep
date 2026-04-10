# Voice Interview Coach

An AI-powered voice interview coach. Upload a job description, get 10 personalised questions, and practice with a voice AI that asks questions, listens to your answers, grades them with Llama 3.3, and produces a full report card.

```
Stack: React · Tailwind · FastAPI · LiveKit · Deepgram Nova-3 · Groq Llama 3.3 · Kokoro TTS
```

---

## Quick Start

### 1 — Prerequisites

| Tool | Version |
|------|---------|
| Python | 3.11+ |
| Node.js | 20+ |
| LiveKit Cloud account | free at livekit.io/cloud |

### 2 — API Keys

Sign up (all free tiers):

| Service | URL | Key used for |
|---------|-----|--------------|
| Deepgram | https://console.deepgram.com | Speech-to-text |
| Groq | https://console.groq.com | LLM (Llama 3.3 70B) |
| Hugging Face | https://huggingface.co/settings/tokens | Kokoro TTS |
| LiveKit Cloud | https://livekit.io/cloud | Real-time audio |

### 3 — Backend setup

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp ../.env.example .env
# Edit .env and fill in your keys
```

### 4 — Frontend setup

```bash
cd frontend
npm install
```

Create `frontend/.env.local` (optional — defaults point to localhost):
```
VITE_API_URL=http://localhost:8000
```

### 5 — Run (three terminals)

**Terminal 1 — FastAPI server**
```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload --port 8000
```

**Terminal 2 — LiveKit Agent**
```bash
cd backend
source .venv/bin/activate
python agent.py dev
```
> On first run `agent.py dev` downloads the Silero VAD model (~30 MB). It connects to your LiveKit Cloud project automatically using the `LIVEKIT_*` env vars.

**Terminal 3 — Frontend**
```bash
cd frontend
npm run dev
```

Open **http://localhost:5173** in your browser.

---

## Project Structure

```
interview-coach/
├── backend/
│   ├── main.py              # FastAPI routes (/upload, /generate-questions, /grade-answer, /report …)
│   ├── agent.py             # LiveKit voice agent (STT → LLM → TTS pipeline)
│   ├── requirements.txt
│   ├── .env.example
│   ├── sessions/            # Per-session JSON (in-memory equivalent, no DB)
│   └── utils/
│       ├── parser.py        # PDF + Q&A text parsing
│       └── kokoro_tts.py    # Custom LiveKit TTS plugin for Kokoro/HuggingFace
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx                       # Top-level routing (Upload → Interview → Report)
│   │   └── components/
│   │       ├── Upload.jsx                # JD + Q&A drag-and-drop upload
│   │       ├── Interview.jsx             # Live voice interview UI + LiveKit room
│   │       ├── Report.jsx                # Post-interview report card
│   │       └── AudioVisualizer.jsx       # Canvas waveform (Web Audio API)
│   ├── package.json
│   └── tailwind.config.js
│
└── .env.example
```

---

## Architecture

```
Browser (React)
   │
   │  REST: /upload, /generate-questions, /livekit-token
   ▼
FastAPI (main.py)  ──── sessions/*.json ────┐
                                            │
LiveKit Cloud ──────────────────────────────┤
   │                                        │
   │  WebRTC audio                          │
   ▼                                        │
LiveKit Agent (agent.py)                    │
   ├─ STT: Deepgram Nova-3 (streaming)      │
   ├─ LLM: Groq Llama 3.3 70B              │
   └─ TTS: Kokoro (HF) or ElevenLabs       │
          │ grade each answer via HTTP ─────┘
          │ (/grade-answer → Groq)
```

### Flow

1. User uploads JD → FastAPI parses it and creates a session
2. Groq generates 8–10 interview questions
3. FastAPI issues a LiveKit JWT; browser joins the room
4. Agent joins the same room, reads questions from the session file
5. Agent speaks each question via TTS; Deepgram transcribes user's answer
6. After each answer, agent calls `/grade-answer` (Groq, silent)
7. Agent sends `{"type":"interview_complete"}` data message when done
8. Browser polls `/report/{session_id}` → full report card rendered

---

## TTS Options

### Kokoro (default — free)

Uses `hexgrad/Kokoro-82M` via the Hugging Face Inference API. Set `HUGGINGFACE_API_KEY`.

Available voices: `af`, `af_bella`, `af_sarah`, `am_adam`, `am_michael`, `bf_emma`, `bm_george`

Edit `agent.py` → `build_tts()` to change the voice.

### ElevenLabs (higher quality, free tier)

Set `ELEVENLABS_API_KEY` and comment out `HUGGINGFACE_API_KEY` in `.env`. The agent auto-selects ElevenLabs when its key is present.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPGRAM_API_KEY` | ✅ | Deepgram Nova-3 STT |
| `GROQ_API_KEY` | ✅ | Llama 3.3 LLM + question generation + grading |
| `HUGGINGFACE_API_KEY` | one of these | Kokoro TTS |
| `ELEVENLABS_API_KEY` | one of these | ElevenLabs TTS |
| `LIVEKIT_URL` | ✅ | `wss://your-app.livekit.cloud` |
| `LIVEKIT_API_KEY` | ✅ | LiveKit project API key |
| `LIVEKIT_API_SECRET` | ✅ | LiveKit project API secret |
| `FRONTEND_URL` | optional | CORS origin (default `http://localhost:5173`) |
| `BACKEND_URL` | optional | Agent → FastAPI URL (default `http://localhost:8000`) |

---

## Troubleshooting

**Agent won't connect to LiveKit**
- Make sure `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` match the LiveKit Cloud project settings exactly.
- Run `python agent.py dev` — "dev" mode auto-creates a test room.

**Kokoro TTS returns 503**
- The HuggingFace model is loading (cold start). The agent retries once after 10 s. If it keeps failing, switch to ElevenLabs.

**No audio from agent in browser**
- Check browser mic permissions. LiveKit requires HTTPS in production (localhost is exempt).

**livekit-agents version mismatch**
- The agent uses the `0.11/0.12` API. If you install a newer major version, check the migration guide at https://docs.livekit.io/agents/overview/.
