"""LiveKit Agent — Voice Interview Orchestrator (livekit-agents 1.x).

Run separately from the FastAPI server:
    python agent.py dev          # development (connects to LiveKit Cloud)
    python agent.py start        # production
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
    llm,
)
from livekit.plugins import deepgram, silero
from livekit.plugins import openai as lk_openai

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

SESSIONS_DIR = Path("sessions")
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------


def load_session(session_id: str) -> dict:
    p = SESSIONS_DIR / f"{session_id}.json"
    with open(p) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# TTS factory
# ---------------------------------------------------------------------------


def build_tts():
    """Return a TTS provider based on available API keys."""
    el_key = os.getenv("ELEVENLABS_API_KEY")
    hf_key = os.getenv("HUGGINGFACE_API_KEY")

    if el_key:
        try:
            from livekit.plugins import elevenlabs

            logger.info("Using ElevenLabs TTS")
            return elevenlabs.TTS(
                api_key=el_key,
                voice_id="EXAVITQu4vr4xnSDxMaL",  # "Bella" – calm, professional
                model="eleven_turbo_v2_5",
            )
        except ImportError:
            logger.warning("livekit-plugins-elevenlabs not installed; falling back")

    if hf_key:
        try:
            from utils.kokoro_tts import KokoroTTS

            logger.info("Using Kokoro TTS via Hugging Face")
            return KokoroTTS(api_key=hf_key, voice="af_bella")
        except Exception as exc:
            logger.warning("KokoroTTS unavailable (%s); falling back", exc)

    logger.info("Using OpenAI TTS (fallback)")
    return lk_openai.TTS(voice="nova")


# ---------------------------------------------------------------------------
# Answer grading
# ---------------------------------------------------------------------------


async def grade_answer(session_id: str, question: str, answer: str, q_index: int):
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            await client.post(
                f"{BACKEND_URL}/grade-answer/{session_id}",
                json={"question": question, "answer": answer, "question_index": q_index},
            )
        logger.info("Graded answer for question %d", q_index)
    except Exception as exc:
        logger.error("Failed to grade answer %d: %s", q_index, exc)


# ---------------------------------------------------------------------------
# Data message helpers
# ---------------------------------------------------------------------------


async def send_data(room: rtc.Room, payload: dict):
    try:
        data = json.dumps(payload).encode()
        await room.local_participant.publish_data(data, reliable=True)
    except Exception as exc:
        logger.warning("send_data failed: %s", exc)


# ---------------------------------------------------------------------------
# Agent entrypoint
# ---------------------------------------------------------------------------


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    session_id = ctx.room.name
    logger.info("Agent joined room: %s", session_id)

    try:
        interview_data = load_session(session_id)
    except FileNotFoundError:
        logger.error("Session file not found for room %s", session_id)
        return

    questions: list[str] = interview_data.get("questions", [])
    if not questions:
        logger.error("No questions found in session %s", session_id)
        return

    jd_snippet = interview_data.get("jd_text", "")[:1500]
    n = len(questions)
    questions_block = "\n".join(f"{i + 1}. {q}" for i, q in enumerate(questions))

    system_prompt = f"""You are Alex, a warm and professional interview coach conducting a structured job interview.

You have exactly {n} questions to ask. Here they are in order:
{questions_block}

STRICT RULES:
1. Begin by welcoming the candidate (2 sentences max) and immediately ask Question 1.
2. After the candidate finishes answering, give ONE brief neutral acknowledgment
   (e.g. "Got it, thank you." or "Understood.") — then ask the next question.
3. Do NOT give feedback, scores, hints, or encouragement during the interview.
4. Do NOT ask follow-up questions or go off-script.
5. Ask all {n} questions in order — do not skip any.
6. After the candidate answers Question {n}, say:
   "Thank you for completing the interview. Your responses are being reviewed — you'll see your full report shortly. Goodbye!"
   Then stop talking.

Job context (for your understanding only — do not mention to candidate):
{jd_snippet}

Start the interview now."""

    answer_count = 0
    answer_lock = asyncio.Lock()

    agent = Agent(instructions=system_prompt)

    agent_session = AgentSession(
        stt=deepgram.STT(model="nova-2", language="en-US"),
        llm=lk_openai.LLM(
            model="llama-3.3-70b-versatile",
            base_url="https://api.groq.com/openai/v1",
            api_key=os.environ["GROQ_API_KEY"],
        ),
        tts=build_tts(),
        vad=silero.VAD.load(),
        min_endpointing_delay=1.2,
        max_endpointing_delay=6.0,
        allow_interruptions=False,
    )

    # -----------------------------------------------------------------------
    # Event handlers
    # -----------------------------------------------------------------------

    @agent_session.on("user_input_transcribed")
    def on_user_input(event):
        if getattr(event, "is_final", True):
            text = getattr(event, "transcript", "")
            asyncio.ensure_future(_handle_answer(text))

    @agent_session.on("agent_speech_committed")
    def on_agent_speech(event):
        text = getattr(event, "text", "") or getattr(event, "content", "") or ""
        if "your full report shortly" in text.lower() or "goodbye" in text.lower():
            asyncio.ensure_future(_finish_interview())

    async def _handle_answer(text: str):
        nonlocal answer_count
        async with answer_lock:
            if not text.strip() or answer_count >= n:
                return
            q_idx = answer_count
            question = questions[q_idx]
            answer_count += 1
            logger.info("Answer %d recorded (%d chars)", q_idx, len(text))

            await send_data(
                ctx.room,
                {"type": "answer_recorded", "question_index": q_idx, "total": n},
            )
            asyncio.ensure_future(grade_answer(session_id, question, text, q_idx))

    async def _finish_interview():
        await asyncio.sleep(3)
        logger.info("Interview complete for session %s", session_id)
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(f"{BACKEND_URL}/complete-interview/{session_id}")
        except Exception as exc:
            logger.warning("Could not mark session complete: %s", exc)
        await send_data(ctx.room, {"type": "interview_complete", "session_id": session_id})

    # -----------------------------------------------------------------------
    # Start
    # -----------------------------------------------------------------------

    await agent_session.start(agent=agent, room=ctx.room)
    await asyncio.sleep(1)

    await agent_session.say(
        "Welcome! I'm Alex, your interview coach. We'll go through a structured interview today. "
        "I'll ask you questions one at a time — take your time with each answer. Let's begin.",
        allow_interruptions=False,
    )

    await asyncio.Event().wait()


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
