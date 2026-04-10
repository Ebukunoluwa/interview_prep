"""FastAPI backend for the Voice Interview Coach."""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from typing import List
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from livekit.api import AccessToken, VideoGrants
from pydantic import BaseModel

from utils.parser import parse_file, parse_qa_pairs, parse_text

load_dotenv()

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Interview Coach API")

import traceback as _tb
from fastapi import Request
from fastapi.responses import JSONResponse

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    detail = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
    print("UNHANDLED EXCEPTION:", detail)
    return JSONResponse(status_code=500, content={"detail": detail})

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

SESSIONS_DIR = Path(os.getenv("SESSIONS_DIR", "sessions"))
SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", "uploads"))
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_INDEX = UPLOADS_DIR / "index.json"

BANKS_FILE = SESSIONS_DIR / "banks.json"
MAX_QUESTIONS = 15

groq_client = Groq(api_key=os.environ["GROQ_API_KEY"])

# ---------------------------------------------------------------------------
# Document library helpers
# ---------------------------------------------------------------------------


def load_doc_index() -> list[dict]:
    if not UPLOADS_INDEX.exists():
        return []
    with open(UPLOADS_INDEX) as f:
        return json.load(f)


def save_doc_index(docs: list[dict]) -> None:
    with open(UPLOADS_INDEX, "w") as f:
        json.dump(docs, f, indent=2)


def register_doc(doc_id: str, name: str, file_path: Path, size: int) -> dict:
    entry = {
        "id": doc_id,
        "name": name,
        "path": str(file_path),
        "size": size,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
    }
    index = load_doc_index()
    index.append(entry)
    save_doc_index(index)
    return entry


def get_doc(doc_id: str) -> dict:
    entry = next((d for d in load_doc_index() if d["id"] == doc_id), None)
    if not entry:
        raise HTTPException(status_code=404, detail=f"Saved document '{doc_id}' not found")
    return entry


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Question bank helpers
# ---------------------------------------------------------------------------


def load_banks() -> list[dict]:
    if not BANKS_FILE.exists():
        return []
    with open(BANKS_FILE) as f:
        return json.load(f)


def save_banks(banks: list[dict]) -> None:
    with open(BANKS_FILE, "w") as f:
        json.dump(banks, f, indent=2)


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------


def session_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def save_session(session_id: str, data: dict) -> None:
    with open(session_path(session_id), "w") as f:
        json.dump(data, f, indent=2)


def load_session(session_id: str) -> dict:
    p = session_path(session_id)
    if not p.exists():
        raise HTTPException(status_code=404, detail="Session not found")
    with open(p) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Question banks
# ---------------------------------------------------------------------------


@app.get("/banks")
async def list_banks():
    return load_banks()


class SaveBankPayload(BaseModel):
    name: str
    questions: list[str]
    session_id: str | None = None


@app.post("/banks")
async def save_bank(payload: SaveBankPayload):
    bank_id = uuid.uuid4().hex[:10]
    bank = {
        "id": bank_id,
        "name": payload.name,
        "questions": payload.questions[:MAX_QUESTIONS],
        "session_id": payload.session_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    banks = load_banks()
    banks.append(bank)
    save_banks(banks)
    return bank


@app.delete("/banks/{bank_id}")
async def delete_bank(bank_id: str):
    banks = load_banks()
    if not any(b["id"] == bank_id for b in banks):
        raise HTTPException(status_code=404, detail="Bank not found")
    save_banks([b for b in banks if b["id"] != bank_id])
    return {"deleted": bank_id}


# ---------------------------------------------------------------------------
# Document library
# ---------------------------------------------------------------------------


@app.get("/documents")
async def list_documents():
    """List all saved documents in the library."""
    return load_doc_index()


@app.delete("/documents/{doc_id}")
async def delete_document(doc_id: str):
    """Delete a saved document from the library."""
    index = load_doc_index()
    entry = next((d for d in index if d["id"] == doc_id), None)
    if not entry:
        raise HTTPException(status_code=404, detail="Document not found")
    p = Path(entry["path"])
    if p.exists():
        p.unlink()
    save_doc_index([d for d in index if d["id"] != doc_id])
    return {"deleted": doc_id}


@app.post("/add-saved-documents/{session_id}")
async def add_saved_documents(session_id: str, body: dict):
    """Add previously saved documents to an existing session and regenerate questions."""
    doc_ids: list[str] = body.get("doc_ids", [])
    if not doc_ids:
        raise HTTPException(status_code=422, detail="No doc_ids provided")

    session = load_session(session_id)
    new_docs: list[dict] = []
    for doc_id in doc_ids:
        entry = get_doc(doc_id)
        content = Path(entry["path"]).read_bytes()
        try:
            text = parse_file(content, entry["name"], groq_client=groq_client)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not re-parse '{entry['name']}': {exc}")
        if text.strip():
            new_docs.append({"id": doc_id, "name": entry["name"], "text": text.strip()})

    if not new_docs:
        raise HTTPException(status_code=422, detail="No text could be extracted from the selected documents")

    existing_docs = session.get("documents") or [{"name": "original", "text": session["jd_text"]}]
    all_docs = existing_docs + new_docs
    session["documents"] = all_docs
    session["jd_text"] = "\n\n".join(d["text"] for d in all_docs)
    save_session(session_id, session)

    prompt = _build_question_prompt(all_docs, session.get("qa_pairs", []))
    response = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        max_tokens=2048,
    )
    raw = response.choices[0].message.content.strip()
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if not match:
        raise HTTPException(status_code=500, detail="LLM returned unexpected format")

    questions: list[str] = json.loads(match.group())[:MAX_QUESTIONS]
    session["questions"] = questions
    session["status"] = "questions_ready"
    save_session(session_id, session)

    return {"session_id": session_id, "questions": questions}


async def _parse_uploads(files: List[UploadFile]) -> list[dict]:
    """Parse uploaded files, save to disk, and return labeled document dicts."""
    docs = []
    for f in files:
        content = await f.read()
        # Save raw file to uploads/
        doc_id = uuid.uuid4().hex[:10]
        safe_name = re.sub(r"[^\w\-.]", "_", f.filename or "document")
        file_path = UPLOADS_DIR / f"{doc_id}_{safe_name}"
        file_path.write_bytes(content)
        register_doc(doc_id, f.filename or "document", file_path, len(content))
        # Parse text
        try:
            text = parse_file(content, f.filename or "", groq_client=groq_client)
        except HTTPException:
            raise
        except Exception as exc:
            err = "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
            print("PARSE ERROR:", err)
            raise HTTPException(status_code=422, detail=f"Could not parse '{f.filename}': {exc}\n\n{err}")
        if text.strip():
            docs.append({"id": doc_id, "name": f.filename or "document", "text": text.strip()})
    return docs


def _build_question_prompt(documents: list[dict], qa_pairs: list[dict]) -> str:
    """Build the question-generation prompt from labeled documents."""
    labeled = "\n\n".join(
        f"=== FILE: {d['name']} ===\n{d['text'][:12000]}"
        for d in documents
    )

    bank_hint = ""
    if qa_pairs:
        bank_hint = "\n\nThe candidate also provided these specific questions they want to practise:\n" + \
                    "\n".join(f"- {p['question']}" for p in qa_pairs)

    return f"""You are a senior technical interviewer and career coach. You have been given one or more documents about a candidate and/or role. Study ALL of them carefully before generating questions.

DOCUMENTS:
{labeled}{bank_hint}

STEP 1 — Before writing any questions, mentally list every distinct topic, technology, skill, domain, and responsibility mentioned across ALL documents (e.g. AI, machine learning, Python, leadership, stakeholder management, etc.). Make sure NONE of these are missed.

STEP 2 — Generate questions that cover every topic from Step 1. If a topic appears in the documents, there must be at least one question about it.

YOUR TASK — read every document and apply these rules:

1. JOB DESCRIPTION / ROLE SPEC (if present)
   → Extract key responsibilities, required skills, technologies, and competencies.
   → Generate technical, situational, and role-specific questions based on these.

2. CV / RESUME (if present)
   → Read the candidate's work history, projects, achievements, and listed skills in detail.
   → Create questions that probe THEIR specific experiences — reference real details
     (e.g. "You led the migration at X — what was the biggest challenge?").
   → Surface anything unusual, impressive, or worth exploring deeper.

3. QUESTION BANK / QUESTION LIST (if present)
   → These are pre-written questions. SELECT the ones most relevant to this candidate and role.
   → Include them verbatim or lightly adapted.
   → If the bank doesn't cover an important area, CREATE new questions to fill the gap.

4. SKILLS / COMPETENCY / BEHAVIOURAL DOCUMENTS (if present)
   → Generate targeted questions for each competency or behavioural area listed.

RULES:
- Generate up to {MAX_QUESTIONS} questions — pick the most valuable ones, no filler.
- No duplicate or near-duplicate questions.
- Be specific — name real technologies, companies, projects from the documents.
- Each question is one clear sentence.
- Only include questions that add genuine value.

Return ONLY a valid JSON array of question strings (maximum {MAX_QUESTIONS} items). No numbering, no markdown, no extra text.
Example: ["Tell me about your work on X at Y.", "How would you approach Z?"]"""


@app.post("/upload")
async def upload_documents(
    jd_files: List[UploadFile] = File(...),
    qa_file: UploadFile = File(None),
):
    """Upload one or more files (JD, CV, question bank, etc.) and an optional Q&A file."""
    documents = await _parse_uploads(jd_files)
    if not documents:
        raise HTTPException(status_code=422, detail="Could not extract text from any uploaded file")

    # Flat text for grading context
    jd_text = "\n\n".join(d["text"] for d in documents)

    qa_pairs: list[dict] = []
    if qa_file:
        qa_content = await qa_file.read()
        qa_text = parse_text(qa_content)
        qa_pairs = parse_qa_pairs(qa_text)

    session_id = uuid.uuid4().hex[:10]
    session_data = {
        "session_id": session_id,
        "documents": documents,
        "jd_text": jd_text,
        "qa_pairs": qa_pairs,
        "questions": [],
        "answers": [],
        "grades": [],
        "status": "uploaded",
    }
    save_session(session_id, session_data)

    return {
        "session_id": session_id,
        "jd_preview": jd_text[:300],
        "qa_count": len(qa_pairs),
    }


@app.post("/generate-questions/{session_id}")
async def generate_questions(session_id: str):
    """Generate questions from all uploaded documents in the session."""
    session = load_session(session_id)
    documents = session.get("documents") or [{"name": "context", "text": session["jd_text"]}]
    qa_pairs = session.get("qa_pairs", [])

    prompt = _build_question_prompt(documents, qa_pairs)

    response = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        max_tokens=2048,
    )

    raw = response.choices[0].message.content.strip()
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if not match:
        raise HTTPException(status_code=500, detail="LLM returned unexpected format for questions")

    questions: list[str] = json.loads(match.group())[:MAX_QUESTIONS]
    if not isinstance(questions, list) or not questions:
        raise HTTPException(status_code=500, detail="Question list is empty")

    session["questions"] = questions
    session["status"] = "questions_ready"
    save_session(session_id, session)

    return {"session_id": session_id, "questions": questions}


@app.post("/add-documents/{session_id}")
async def add_documents(
    session_id: str,
    jd_files: List[UploadFile] = File(...),
):
    """Append new documents to an existing session and regenerate questions."""
    session = load_session(session_id)

    new_docs = await _parse_uploads(jd_files)
    if not new_docs:
        raise HTTPException(status_code=422, detail="No text could be extracted from the new files")

    # Merge into session documents
    existing_docs = session.get("documents") or [{"name": "original context", "text": session["jd_text"]}]
    all_docs = existing_docs + new_docs
    session["documents"] = all_docs
    session["jd_text"] = "\n\n".join(d["text"] for d in all_docs)
    save_session(session_id, session)

    prompt = _build_question_prompt(all_docs, session.get("qa_pairs", []))

    response = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        max_tokens=2048,
    )

    raw = response.choices[0].message.content.strip()
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if not match:
        raise HTTPException(status_code=500, detail="LLM returned unexpected format")

    questions: list[str] = json.loads(match.group())[:MAX_QUESTIONS]
    session["questions"] = questions
    session["status"] = "questions_ready"
    save_session(session_id, session)

    return {"session_id": session_id, "questions": questions, "added_docs": len(new_docs)}


@app.get("/questions/{session_id}/download")
async def download_questions(session_id: str):
    """Return questions as a plain-text file download."""
    from fastapi.responses import PlainTextResponse
    session = load_session(session_id)
    questions = session.get("questions", [])
    if not questions:
        raise HTTPException(status_code=404, detail="No questions generated yet")
    lines = "\n".join(f"{i+1}. {q}" for i, q in enumerate(questions))
    text = f"Interview Questions\nSession: {session_id}\n\n{lines}\n"
    return PlainTextResponse(
        content=text,
        headers={"Content-Disposition": f'attachment; filename="questions_{session_id}.txt"'},
    )


@app.get("/livekit-token/{session_id}")
async def get_livekit_token(session_id: str):
    """Issue a LiveKit JWT so the browser can join the interview room."""
    load_session(session_id)  # existence check

    api_key = os.environ["LIVEKIT_API_KEY"]
    api_secret = os.environ["LIVEKIT_API_SECRET"]

    token = (
        AccessToken(api_key, api_secret)
        .with_grants(VideoGrants(room_join=True, room=session_id))
        .with_identity(f"candidate-{session_id}")
        .with_name("Candidate")
        .to_jwt()
    )

    return {
        "token": token,
        "room": session_id,
        "url": os.environ["LIVEKIT_URL"],
    }


class SuggestPayload(BaseModel):
    question: str
    question_index: int


class RealtimePayload(BaseModel):
    transcript: str


@app.post("/realtime-assist/{session_id}")
async def realtime_assist(session_id: str, payload: RealtimePayload):
    """Always-on assistant: detects interview questions or partial answers and responds instantly."""
    text = payload.transcript.strip()
    if not text or len(text) < 8:
        return {"answer": None, "type": None}

    session = load_session(session_id)
    documents = session.get("documents") or [{"name": "context", "text": session["jd_text"]}]
    doc_context = "\n\n".join(
        f"=== {d['name']} ===\n{d['text'][:3000]}" for d in documents
    )

    prompt = f"""You are a real-time interview assistant. The candidate just heard or started saying:

"{text}"

CANDIDATE CONTEXT (CV, job description, skills):
{doc_context}

TASK:
1. Classify what was said into one of:
   - "question": an interview question being asked to the candidate
   - "completion": the candidate started speaking an answer but didn't finish
   - "skip": completely unrelated to interviews (e.g. "pass me the water", "okay thanks bye")

   When in doubt, classify as "question" or "completion" rather than "skip". It is better to give a useful answer than to stay silent.

2. Write a complete, strong answer the candidate can use:
   - For ANY behavioural, situational, or competency question (tell me about a time, describe a situation, how do you handle, give an example of, what would you do, etc.): structure the answer using the STAR method:
     **Situation** – briefly set the scene
     **Task** – what your responsibility was
     **Action** – the specific steps YOU personally took
     **Result** – concrete, measurable outcome (numbers/impact preferred)
   - For technical questions: give a direct expert-level answer with a concrete example
   - If "completion": continue seamlessly from where they stopped and close with a STAR result where applicable
   - Draw on the candidate's CV, experience, and skills from the context above wherever possible
   - 5–8 sentences, confident, specific, no filler

Return ONLY valid JSON:
{{"type": "question"|"completion"|"skip", "answer": "<full answer or null if skip>"}}"""

    response = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.4,
        max_tokens=512,
    )

    raw = response.choices[0].message.content.strip()
    match = re.search(r'\{.*\}', raw, re.DOTALL)
    if not match:
        return {"answer": None, "type": None}

    try:
        result = json.loads(match.group())
        if result.get("type") == "skip":
            return {"answer": None, "type": None}
        return {"answer": result.get("answer"), "type": result.get("type")}
    except Exception:
        return {"answer": None, "type": None}


@app.post("/suggest-answer/{session_id}")
async def suggest_answer(session_id: str, payload: SuggestPayload):
    """Generate a suggested answer for a question using the candidate's documents as context."""
    session = load_session(session_id)
    documents = session.get("documents") or [{"name": "context", "text": session["jd_text"]}]

    doc_context = "\n\n".join(
        f"=== {d['name']} ===\n{d['text'][:4000]}" for d in documents
    )

    prompt = f"""You are an expert interview coach helping a candidate prepare. Using the candidate's background and the job context below, write a strong, personalised answer to the interview question.

CANDIDATE CONTEXT (CV, job description, skills, etc.):
{doc_context}

QUESTION: {payload.question}

INSTRUCTIONS:
- If this is a behavioural or situational question ("Tell me about a time...", "Describe a situation...", "How would you handle..."), use the STAR format: Situation → Task → Action → Result. Make the result concrete with numbers or outcomes where possible.
- If this is a technical question, give a direct, expert-level answer instead — no STAR needed.
- Draw on specific details from the candidate's CV (companies, projects, technologies, achievements) wherever relevant to make the answer feel personal and credible.
- If the CV doesn't have enough specifics, use plausible but realistic examples that fit the role.
- 4–8 sentences. Confident, clear, no waffle.

Return ONLY the answer text. No labels, no preamble."""

    response = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.5,
        max_tokens=1024,
    )

    return {"answer": response.choices[0].message.content.strip()}


class GradePayload(BaseModel):
    question: str
    answer: str
    question_index: int


@app.post("/grade-answer/{session_id}")
async def grade_answer(session_id: str, payload: GradePayload):
    """Grade a single answer with Groq. Called by the agent after each response."""
    session = load_session(session_id)

    documents = session.get("documents") or [{"name": "context", "text": session["jd_text"]}]
    doc_context = "\n\n".join(
        f"=== {d['name']} ===\n{d['text'][:3000]}" for d in documents
    )

    prompt = f"""You are a professional interview coach. Grade the following interview answer.

Context (job description, CV, question bank, etc.):
{doc_context}

Question: {payload.question}
Candidate's Answer: {payload.answer}

Evaluate and return ONLY valid JSON with these exact keys:
{{
  "score": <integer 1–10>,
  "feedback": "<2–3 sentence specific feedback on what was good and what was missing>",
  "strengths": ["<strength 1>", "<strength 2>"],
  "improvements": ["<improvement 1>", "<improvement 2>"],
  "example_answer": "<Write a strong example answer following these rules: (1) If the question is behavioural or situational (e.g. 'Tell me about a time...', 'How would you handle...', 'Describe a situation...'), use the STAR format — clearly cover Situation, Task, Action, and Result with a concrete outcome. (2) If the candidate's answer was reasonable (score 4+), rewrite it using their own context and examples but make it stronger, more specific, and STAR-structured where applicable. (3) If the answer was poor, vague, or off-track (score 1–3), ignore what they said and write a completely fresh model answer from scratch. (4) For technical questions, skip STAR and give a direct, expert-level explanation instead. Either way: 4–7 sentences, concrete, specific, no filler.>"
}}"""

    response = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=1024,
    )

    raw = response.choices[0].message.content.strip()
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        grade = json.loads(match.group())
    else:
        grade = {
            "score": 5,
            "feedback": "Answer recorded but could not be graded automatically.",
            "strengths": [],
            "improvements": [],
            "example_answer": "",
        }

    grade["question"] = payload.question
    grade["answer"] = payload.answer
    grade["question_index"] = payload.question_index

    session.setdefault("grades", [])
    session["grades"] = [
        g for g in session["grades"] if g.get("question_index") != payload.question_index
    ]
    session["grades"].append(grade)
    session["grades"].sort(key=lambda x: x.get("question_index", 0))
    save_session(session_id, session)

    return grade


@app.post("/complete-interview/{session_id}")
async def complete_interview(session_id: str):
    """Mark the interview session as completed."""
    session = load_session(session_id)
    session["status"] = "completed"
    save_session(session_id, session)
    return {"status": "completed"}


@app.get("/report/{session_id}")
async def get_report(session_id: str):
    """Generate and return the final interview report."""
    session = load_session(session_id)
    grades = session.get("grades", [])

    if not grades:
        raise HTTPException(status_code=400, detail="No graded answers found for this session")

    avg_score = round(sum(g["score"] for g in grades) / len(grades), 1)
    all_strengths = list({s for g in grades for s in g.get("strengths", [])})
    all_improvements = list({i for g in grades for i in g.get("improvements", [])})

    summary_prompt = f"""Write a 2–3 sentence coaching summary for an interview candidate.

Performance:
- Overall score: {avg_score}/10 across {len(grades)} questions
- Top strengths: {', '.join(all_strengths[:4]) or 'None recorded'}
- Areas to improve: {', '.join(all_improvements[:4]) or 'None recorded'}

Be encouraging but honest. Be specific about what they should do next."""

    summary_resp = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": summary_prompt}],
        temperature=0.5,
        max_tokens=256,
    )
    coaching_summary = summary_resp.choices[0].message.content.strip()

    return {
        "session_id": session_id,
        "questions": session.get("questions", []),
        "grades": grades,
        "overall_score": avg_score,
        "strengths": all_strengths[:6],
        "improvements": all_improvements[:6],
        "coaching_summary": coaching_summary,
        "status": session.get("status"),
    }


@app.get("/session/{session_id}/extracted-text")
async def get_extracted_text(session_id: str):
    """Return the text extracted from each uploaded document — useful for debugging."""
    session = load_session(session_id)
    documents = session.get("documents") or []
    return {
        "documents": [
            {"name": d["name"], "chars": len(d["text"]), "preview": d["text"][:500]}
            for d in documents
        ]
    }


@app.get("/session/{session_id}/status")
async def session_status(session_id: str):
    session = load_session(session_id)
    return {
        "status": session.get("status"),
        "grades_count": len(session.get("grades", [])),
        "questions_count": len(session.get("questions", [])),
    }
