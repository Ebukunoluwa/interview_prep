import { useState, useRef, useEffect } from 'react'
import API from '../api'
const DEBOUNCE_MS = 600
const MIN_CHARS = 5

export default function AssistantListener({ sessionId }) {
  const [active, setActive] = useState(false)
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [answer, setAnswer] = useState('')
  const [answerType, setAnswerType] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Refs — avoid stale closure issues entirely
  const activeRef = useRef(false)
  const sessionIdRef = useRef(sessionId)
  const recognitionRef = useRef(null)
  const debounceRef = useRef(null)
  const accumulatedRef = useRef('')
  const transcriptRef = useRef('')
  const answerRef = useRef('')
  const loadingRef = useRef(false)

  // Keep refs in sync
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])
  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => { transcriptRef.current = transcript }, [transcript])
  useEffect(() => { answerRef.current = answer }, [answer])
  useEffect(() => { loadingRef.current = loading }, [loading])

  // Keypress while active:
  //   • answer showing  → clear and go back to listening
  //   • listening/transcript → immediately submit what's been heard so far
  useEffect(() => {
    if (!active) return
    function handleKey(e) {
      // Ignore modifier-only keys and Escape (Escape used for nothing here but keep it clean)
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(e.key)) return

      if (answerRef.current) {
        // Answer shown → clear and start fresh
        clearTimeout(debounceRef.current)
        accumulatedRef.current = ''
        transcriptRef.current = ''
        setAnswer('')
        setTranscript('')
        setAnswerType('')
      } else if (!loadingRef.current) {
        // Still listening → grab everything heard so far and fire immediately
        const captured = (accumulatedRef.current + ' ' + transcriptRef.current).trim()
        clearTimeout(debounceRef.current)
        accumulatedRef.current = ''
        transcriptRef.current = ''
        setTranscript('')
        if (captured.length >= MIN_CHARS) triggerAssist(captured)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [active])

  // ── Speech recognition ───────────────────────────────────────────────────

  function startSession() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { setError('Requires Chrome or Edge.'); return }

    const rec = new SR()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    recognitionRef.current = rec

    rec.onstart = () => setListening(true)

    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          accumulatedRef.current += e.results[i][0].transcript + ' '
        } else {
          interim += e.results[i][0].transcript
        }
      }

      const full = (accumulatedRef.current + interim).trim()
      setTranscript(full)

      clearTimeout(debounceRef.current)
      // Don't auto-fire debounce while an answer is already displayed or loading
      if (full.length >= MIN_CHARS && !answerRef.current && !loadingRef.current) {
        debounceRef.current = setTimeout(() => {
          if (answerRef.current || loadingRef.current) return
          const captured = accumulatedRef.current.trim()
          accumulatedRef.current = ''
          setTranscript('')
          if (captured.length >= MIN_CHARS) triggerAssist(captured)
        }, DEBOUNCE_MS)
      }
    }

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return
      setError(`Mic error: ${e.error}`)
    }

    rec.onend = () => {
      setListening(false)
      if (activeRef.current) {
        setTimeout(() => { if (activeRef.current) startSession() }, 250)
      }
    }

    try { rec.start() } catch (_) {}
  }

  function activate() {
    setError('')
    setAnswer('')
    setTranscript('')
    accumulatedRef.current = ''
    activeRef.current = true
    setActive(true)
    startSession()
  }

  function deactivate() {
    activeRef.current = false
    setActive(false)
    setListening(false)
    clearTimeout(debounceRef.current)
    try { recognitionRef.current?.stop() } catch (_) {}
    recognitionRef.current = null
    setTranscript('')
  }

  // ── Backend ──────────────────────────────────────────────────────────────

  async function triggerAssist(text) {
    const sid = sessionIdRef.current   // always latest
    console.log('[Assistant] trigger →', JSON.stringify(text), 'session:', sid)

    if (!sid || !text) {
      console.warn('[Assistant] skipped — no session or empty text')
      return
    }

    setLoading(true)
    setAnswer('')
    setAnswerType('')

    try {
      const res = await fetch(`${API}/realtime-assist/${sid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text }),
      })
      const data = await res.json()
      console.log('[Assistant] response →', data)
      if (data.answer) {
        setAnswer(data.answer)
        setAnswerType(data.type)
      } else {
        console.log('[Assistant] got skip or no answer')
      }
    } catch (err) {
      console.error('[Assistant] fetch error', err)
    } finally {
      setLoading(false)
    }
  }

  if (!sessionId) return null

  return (
    <>
      {/* Idle button — bottom centre when not active */}
      {!active && (
        <div className="fixed bottom-8 inset-x-0 z-50 flex justify-center pointer-events-none">
          <button
            onClick={activate}
            className="pointer-events-auto flex items-center gap-3 px-8 py-4 rounded-full text-lg font-semibold bg-brand-600 hover:bg-brand-500 text-white shadow-2xl hover:scale-105 transition-all duration-200"
          >
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
            Live assistant
          </button>
        </div>
      )}

      {/* Full-screen active overlay */}
      {active && (
        <div className="fixed inset-0 z-50 bg-gray-950/97 backdrop-blur-md flex flex-col">

          {/* Top bar */}
          <div className="flex items-center justify-between px-8 py-4 border-b border-gray-800">
            <div className="flex items-center gap-3">
              <span className={`w-3 h-3 rounded-full ${listening ? 'bg-red-400 animate-pulse' : 'bg-yellow-400'}`} />
              <span className="text-base font-semibold text-gray-200">
                {listening ? 'Listening…' : 'Restarting mic…'}
              </span>
            </div>
            <button
              onClick={deactivate}
              className="text-gray-500 hover:text-white text-2xl leading-none transition-colors"
            >✕</button>
          </div>

          {/* Main content area */}
          <div className="flex-1 flex flex-col items-center justify-center px-10 gap-10 overflow-y-auto py-10">

            {/* Mic orb */}
            {!transcript && !loading && !answer && (
              <div className="flex flex-col items-center gap-6">
                <div className="relative w-28 h-28 flex items-center justify-center">
                  {listening && (
                    <>
                      <span className="absolute inset-0 rounded-full bg-red-600 opacity-20 animate-ping" />
                      <span className="absolute inset-0 rounded-full bg-red-600 opacity-10 animate-ping" style={{ animationDelay: '0.5s' }} />
                    </>
                  )}
                  <div className="relative w-20 h-20 rounded-full bg-red-600 flex items-center justify-center shadow-2xl">
                    <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </svg>
                  </div>
                </div>
                <p className="text-xl text-gray-500 font-light">Speak or ask a question…</p>
              </div>
            )}

            {/* Live transcript */}
            {transcript && !loading && !answer && (
              <p className="text-xl text-gray-400 italic text-center max-w-3xl leading-relaxed font-light">
                "{transcript}"
              </p>
            )}

            {/* Loading */}
            {loading && (
              <div className="flex flex-col items-center gap-5">
                <div className="flex items-center gap-3">
                  {[0,1,2,3,4].map(i => (
                    <div key={i} className="w-3 h-3 rounded-full bg-brand-400 animate-bounce"
                      style={{ animationDelay: `${i * 0.12}s` }} />
                  ))}
                </div>
                <p className="text-lg text-gray-400 font-light">Generating answer…</p>
              </div>
            )}

            {/* Answer */}
            {answer && !loading && (
              <div className="w-full max-w-3xl space-y-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-brand-400 uppercase tracking-widest">
                    {answerType === 'question' ? 'Suggested answer' : 'Completing your answer'}
                  </span>
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => navigator.clipboard.writeText(answer)}
                      className="text-sm text-brand-400 hover:text-brand-300 font-medium"
                    >Copy</button>
                    <button
                      onClick={() => { setAnswer(''); setTranscript(''); setAnswerType('') }}
                      className="text-sm text-gray-500 hover:text-white"
                    >Clear</button>
                  </div>
                </div>
                <p className="text-lg text-white leading-relaxed">{answer}</p>
              </div>
            )}
          </div>

          {/* Bottom hint */}
          <div className="text-center py-6 text-gray-600 text-sm">
            {answer ? 'Press any key to start a new transcript' : 'Press any key to generate answer · ✕ to close'}
          </div>
        </div>
      )}

      {error && (
        <div className="fixed bottom-24 inset-x-0 z-50 flex justify-center">
          <p className="text-base text-red-400 bg-red-900/40 border border-red-800 rounded-xl px-5 py-3">{error}</p>
        </div>
      )}
    </>
  )
}
