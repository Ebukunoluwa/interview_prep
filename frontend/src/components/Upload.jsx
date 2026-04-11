import { useState, useRef, useEffect } from 'react'
import API from '../api'

export default function Upload({ onComplete, onSessionReady }) {
  const [jdFiles, setJdFiles] = useState([])
  const [qaFile, setQaFile] = useState(null)
  const [jdDrag, setJdDrag] = useState(false)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [questions, setQuestions] = useState([])
  const [sessionId, setSessionId] = useState(null)
  const [copied, setCopied] = useState(false)

  // Practice mode state
  const [activeQ, setActiveQ] = useState(null)
  const [answers, setAnswers] = useState({})
  const [grades, setGrades] = useState({})
  const [grading, setGrading] = useState({})
  const recognitionRef = useRef(null)

  // Suggested answers
  const [suggestions, setSuggestions] = useState({})
  const [suggesting, setSuggesting] = useState({})

  async function getSuggestion(index) {
    if (!sessionId) return
    setSuggesting(prev => ({ ...prev, [index]: true }))
    try {
      const res = await fetch(`${API}/suggest-answer/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: questions[index], question_index: index }),
      })
      if (res.ok) {
        const { answer } = await res.json()
        setSuggestions(prev => ({ ...prev, [index]: answer }))
      }
    } finally {
      setSuggesting(prev => ({ ...prev, [index]: false }))
    }
  }
  const jdRef = useRef()
  const qaRef = useRef()

  // Restore saved state on mount
  useEffect(() => {
    const saved = localStorage.getItem('interview_questions')
    if (saved) {
      try {
        const { questions: qs, session_id, answers: ans, grades: gr } = JSON.parse(saved)
        if (qs?.length) {
          setQuestions(qs)
          setSessionId(session_id)
          if (ans) setAnswers(ans)
          if (gr) setGrades(gr)
          onSessionReady?.(session_id)
        }
      } catch (_) {}
    }
  }, [])

  function saveToStorage(qs, sid, ans, gr) {
    localStorage.setItem('interview_questions', JSON.stringify({
      questions: qs, session_id: sid, answers: ans, grades: gr,
    }))
  }

  function copyQuestions() {
    const text = questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // ── Practice mic ────────────────────────────────────────────────────────────

  function toggleQuestion(index) {
    if (activeQ === index) {
      recognitionRef.current?.stop()
      return
    }
    if (activeQ !== null) recognitionRef.current?.stop()
    startRecording(index)
  }

  function startRecording(index) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      setError('Speech recognition not supported — use Chrome or Edge.')
      return
    }

    const recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'

    let finalText = ''

    recognition.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' '
        else interim += e.results[i][0].transcript
      }
      setAnswers(prev => ({ ...prev, [index]: (finalText + interim).trim() }))
    }

    recognition.onend = () => {
      setActiveQ(null)
      const text = finalText.trim()
      if (text) {
        setAnswers(prev => {
          const next = { ...prev, [index]: text }
          saveToStorage(questions, sessionId, next, grades)
          return next
        })
        gradeAnswer(index, text)
      }
    }

    recognition.onerror = (e) => {
      setActiveQ(null)
      if (e.error !== 'no-speech') setError(`Mic error: ${e.error}`)
    }

    recognition.start()
    recognitionRef.current = recognition
    setActiveQ(index)
  }

  async function gradeAnswer(index, text) {
    if (!sessionId) {
      setError('No active session — please generate questions first.')
      return
    }
    setGrading(prev => ({ ...prev, [index]: true }))
    try {
      const res = await fetch(`${API}/grade-answer/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: questions[index], answer: text, question_index: index }),
      })
      if (res.ok) {
        const grade = await res.json()
        setGrades(prev => {
          const next = { ...prev, [index]: grade }
          setAnswers(ans => { saveToStorage(questions, sessionId, ans, next); return ans })
          return next
        })
      } else {
        const detail = await res.text()
        console.error('Grade failed:', res.status, detail)
        setError(`Grading failed (${res.status}) — check your connection and try again.`)
      }
    } catch (err) {
      console.error('Grade error:', err)
      setError('Could not reach the server to grade your answer.')
    } finally {
      setGrading(prev => ({ ...prev, [index]: false }))
    }
  }

  // ── Upload flow ─────────────────────────────────────────────────────────────

  function handleJdDrop(e) {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length) setJdFiles(prev => [...prev, ...files])
    setJdDrag(false)
  }

  function handleJdSelect(e) {
    const files = Array.from(e.target.files)
    if (files.length) setJdFiles(prev => [...prev, ...files])
  }

  function removeJdFile(index) {
    setJdFiles(prev => prev.filter((_, i) => i !== index))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!jdFiles.length) return
    setError('')
    setStatus('uploading')

    try {
      const fd = new FormData()
      for (const f of jdFiles) fd.append('jd_files', f)
      if (qaFile) fd.append('qa_file', qaFile)

      const uploadRes = await fetch(`${API}/upload`, { method: 'POST', body: fd })
      if (!uploadRes.ok) {
        const body = await uploadRes.text()
        let msg; try { msg = JSON.parse(body)?.detail } catch { msg = body }
        throw new Error(`Upload failed (${uploadRes.status}): ${msg || body}`)
      }
      const { session_id } = await uploadRes.json()
      setSessionId(session_id)

      setStatus('generating')
      const genRes = await fetch(`${API}/generate-questions/${session_id}`, { method: 'POST' })
      if (!genRes.ok) {
        const body = await genRes.text()
        let msg; try { msg = JSON.parse(body)?.detail } catch { msg = body }
        throw new Error(`Question generation failed (${genRes.status}): ${msg || body}`)
      }
      const { questions: qs } = await genRes.json()
      setQuestions(qs)
      setAnswers({})
      setGrades({})
      saveToStorage(qs, session_id, {}, {})
      onSessionReady?.(session_id)
      // Refresh library so newly uploaded docs appear
      fetch(`${API}/documents`).then(r => r.json()).then(setLibrary).catch(() => {})

      const tokenRes = await fetch(`${API}/livekit-token/${session_id}`)
      if (!tokenRes.ok) {
        const body = await tokenRes.text()
        let msg; try { msg = JSON.parse(body)?.detail } catch { msg = body }
        throw new Error(`LiveKit token failed (${tokenRes.status}): ${msg || body}`)
      }
      const { token, url } = await tokenRes.json()

      setStatus('done')
      onComplete({ session_id, questions: qs, livekitToken: token, livekitUrl: url })
    } catch (err) {
      setError(err.message || 'Something went wrong — check the backend terminal')
      setStatus('error')
    }
  }

  // Document library
  const [library, setLibrary] = useState([])
  const [selectedLibDocs, setSelectedLibDocs] = useState([])

  // Question banks
  const [banks, setBanks] = useState([])
  const [bankName, setBankName] = useState('')
  const [savingBank, setSavingBank] = useState(false)
  const [showBankInput, setShowBankInput] = useState(false)

  useEffect(() => {
    fetch(`${API}/banks`).then(r => r.json()).then(setBanks).catch(() => {})
  }, [])

  async function saveAsBank() {
    if (!bankName.trim() || !questions.length) return
    setSavingBank(true)
    try {
      const res = await fetch(`${API}/banks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: bankName.trim(), questions, session_id: sessionId }),
      })
      if (res.ok) {
        const bank = await res.json()
        setBanks(prev => [...prev, bank])
        setBankName('')
        setShowBankInput(false)
      }
    } finally {
      setSavingBank(false)
    }
  }

  async function deleteBank(id, e) {
    e.stopPropagation()
    await fetch(`${API}/banks/${id}`, { method: 'DELETE' })
    setBanks(prev => prev.filter(b => b.id !== id))
  }

  function loadBankQuestions(bank) {
    // Merge bank questions with current, dedupe, cap at 15
    const merged = [...new Set([...questions, ...bank.questions])].slice(0, 15)
    setQuestions(merged)
    const newAnswers = {}
    const newGrades = {}
    merged.forEach((q, i) => {
      const oldIdx = questions.indexOf(q)
      if (oldIdx !== -1) {
        if (answers[oldIdx] !== undefined) newAnswers[i] = answers[oldIdx]
        if (grades[oldIdx] !== undefined) newGrades[i] = grades[oldIdx]
      }
    })
    setAnswers(newAnswers)
    setGrades(newGrades)
    saveToStorage(merged, sessionId, newAnswers, newGrades)
  }

  useEffect(() => {
    fetch(`${API}/documents`).then(r => r.json()).then(setLibrary).catch(() => {})
  }, [])

  function toggleLibDoc(id) {
    setSelectedLibDocs(prev =>
      prev.includes(id) ? prev.filter(d => d !== id) : [...prev, id]
    )
  }

  async function addSavedDocsToSession() {
    if (!selectedLibDocs.length || !sessionId) return
    setAddingDocs(true)
    setError('')
    try {
      const res = await fetch(`${API}/add-saved-documents/${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_ids: selectedLibDocs }),
      })
      if (!res.ok) {
        const body = await res.text()
        let msg; try { msg = JSON.parse(body)?.detail } catch { msg = body }
        throw new Error(msg || 'Failed')
      }
      const { questions: qs } = await res.json()
      const newAnswers = {}
      const newGrades = {}
      qs.forEach((q, i) => {
        const oldIdx = questions.indexOf(q)
        if (oldIdx !== -1) {
          if (answers[oldIdx] !== undefined) newAnswers[i] = answers[oldIdx]
          if (grades[oldIdx] !== undefined) newGrades[i] = grades[oldIdx]
        }
      })
      setQuestions(qs)
      setAnswers(newAnswers)
      setGrades(newGrades)
      saveToStorage(qs, sessionId, newAnswers, newGrades)
      setSelectedLibDocs([])
    } catch (err) {
      setError(err.message)
    } finally {
      setAddingDocs(false)
    }
  }

  async function deleteLibDoc(id, e) {
    e.stopPropagation()
    await fetch(`${API}/documents/${id}`, { method: 'DELETE' })
    setLibrary(prev => prev.filter(d => d.id !== id))
    setSelectedLibDocs(prev => prev.filter(d => d !== id))
  }

  // Add-more-docs state
  const [extraFiles, setExtraFiles] = useState([])
  const [addingDocs, setAddingDocs] = useState(false)
  const [addDrag, setAddDrag] = useState(false)
  const extraRef = useRef()

  async function handleAddDocuments() {
    if (!extraFiles.length || !sessionId) return
    setAddingDocs(true)
    setError('')
    try {
      const fd = new FormData()
      for (const f of extraFiles) fd.append('jd_files', f)
      const res = await fetch(`${API}/add-documents/${sessionId}`, { method: 'POST', body: fd })
      if (!res.ok) {
        const body = await res.text()
        let msg; try { msg = JSON.parse(body)?.detail } catch { msg = body }
        throw new Error(msg || 'Failed to add documents')
      }
      const { questions: qs } = await res.json()
      // Preserve answers/grades for questions that still exist by text
      const newAnswers = {}
      const newGrades = {}
      qs.forEach((q, i) => {
        const oldIdx = questions.indexOf(q)
        if (oldIdx !== -1) {
          if (answers[oldIdx] !== undefined) newAnswers[i] = answers[oldIdx]
          if (grades[oldIdx] !== undefined) newGrades[i] = grades[oldIdx]
        }
      })
      setQuestions(qs)
      setAnswers(newAnswers)
      setGrades(newGrades)
      saveToStorage(qs, sessionId, newAnswers, newGrades)
      onSessionReady?.(sessionId)
      setExtraFiles([])
    } catch (err) {
      setError(err.message)
    } finally {
      setAddingDocs(false)
    }
  }

  const busy = status === 'uploading' || status === 'generating'
  const answeredCount = Object.keys(answers).length

  function fullReset() {
    // Stop any active recording
    recognitionRef.current?.stop()
    // Clear all local state
    setJdFiles([])
    setQaFile(null)
    setQuestions([])
    setSessionId(null)
    setAnswers({})
    setGrades({})
    setSuggestions({})
    setActiveQ(null)
    setExtraFiles([])
    setSelectedLibDocs([])
    setShowBankInput(false)
    setBankName('')
    setError('')
    setStatus('idle')
    // Clear persisted data
    localStorage.removeItem('interview_questions')
  }

  return (
    <div className="w-full max-w-xl space-y-6">
      <div className="text-center space-y-2">
        <div className="flex items-center justify-center gap-3">
          <h1 className="text-3xl font-bold">Prepare for your interview</h1>
          {(questions.length > 0 || jdFiles.length > 0) && (
            <button
              type="button"
              onClick={fullReset}
              title="Clear everything and start fresh"
              className="text-xs text-gray-600 hover:text-red-400 border border-gray-700 hover:border-red-700 rounded-lg px-2 py-1 transition-colors"
            >
              ↺ Reset all
            </button>
          )}
        </div>
        <p className="text-gray-400">
          Upload a job description and we'll generate personalised interview questions for you to
          practice with an AI coach.
        </p>
      </div>

      {/* Document Library */}
      {library.length > 0 && (
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Saved documents</p>
            {selectedLibDocs.length > 0 && sessionId && (
              <button type="button" onClick={addSavedDocsToSession} disabled={addingDocs}
                className="text-xs text-brand-400 hover:text-brand-300 font-medium">
                {addingDocs ? 'Adding…' : `Add ${selectedLibDocs.length} to session`}
              </button>
            )}
          </div>
          <div className="space-y-1">
            {library.map(doc => (
              <div
                key={doc.id}
                onClick={() => toggleLibDoc(doc.id)}
                className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer border transition-colors ${
                  selectedLibDocs.includes(doc.id)
                    ? 'border-brand-600 bg-brand-900/20 text-brand-300'
                    : 'border-gray-700 hover:border-gray-600 text-gray-400'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center text-xs ${
                    selectedLibDocs.includes(doc.id) ? 'bg-brand-600 border-brand-600 text-white' : 'border-gray-600'
                  }`}>
                    {selectedLibDocs.includes(doc.id) ? '✓' : ''}
                  </span>
                  <span className="text-sm truncate">{doc.name}</span>
                  <span className="text-xs text-gray-600 flex-shrink-0">
                    {(doc.size / 1024).toFixed(0)} KB
                  </span>
                </div>
                <button type="button" onClick={(e) => deleteLibDoc(doc.id, e)}
                  className="ml-2 text-gray-700 hover:text-red-400 text-xs flex-shrink-0">✕</button>
              </div>
            ))}
          </div>
          {!sessionId && selectedLibDocs.length > 0 && (
            <p className="text-xs text-gray-600">Generate questions first, then add saved docs to the session.</p>
          )}
        </div>
      )}

      {/* Question Banks */}
      {banks.length > 0 && (
        <div className="card space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Question banks</p>
          <div className="space-y-1">
            {banks.map(bank => (
              <div key={bank.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-gray-700 hover:border-gray-600 transition-colors">
                <div className="min-w-0">
                  <p className="text-sm text-gray-300 truncate">{bank.name}</p>
                  <p className="text-xs text-gray-600">{bank.questions.length} questions · {new Date(bank.created_at).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                  <button type="button" onClick={() => loadBankQuestions(bank)}
                    className="text-xs text-brand-400 hover:text-brand-300">Load</button>
                  <button type="button" onClick={(e) => deleteBank(bank.id, e)}
                    className="text-xs text-gray-600 hover:text-red-400">✕</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div
          className={`card cursor-pointer border-2 border-dashed transition-colors ${
            jdDrag ? 'border-brand-500 bg-brand-900/20' : 'border-gray-700 hover:border-gray-600'
          }`}
          onClick={() => jdRef.current.click()}
          onDragOver={(e) => { e.preventDefault(); setJdDrag(true) }}
          onDragLeave={() => setJdDrag(false)}
          onDrop={handleJdDrop}
        >
          <input ref={jdRef} type="file" accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.gif,.webp"
            multiple className="hidden" onChange={handleJdSelect} />
          <div className="text-center space-y-2">
            <UploadIcon className="w-8 h-8 mx-auto text-gray-500" />
            {jdFiles.length > 0 ? (
              <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
                {jdFiles.map((f, i) => (
                  <div key={i} className="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-1.5 text-sm">
                    <span className="text-brand-400 truncate max-w-xs">{f.name}</span>
                    <button type="button" onClick={() => removeJdFile(i)}
                      className="ml-2 text-gray-500 hover:text-red-400 text-xs">✕</button>
                  </div>
                ))}
                <p className="text-xs text-gray-500 pt-1">Click or drop to add more files</p>
              </div>
            ) : (
              <>
                <p className="font-medium">Job Description <span className="text-red-400">*</span></p>
                <p className="text-sm text-gray-500">PDF, DOCX, image, or text — multiple files OK</p>
              </>
            )}
          </div>
        </div>

        <div className="card cursor-pointer border-2 border-dashed border-gray-700 hover:border-gray-600 transition-colors"
          onClick={() => qaRef.current.click()}>
          <input ref={qaRef} type="file" accept=".txt,.md" className="hidden"
            onChange={(e) => setQaFile(e.target.files[0])} />
          <div className="text-center space-y-1">
            <p className="font-medium text-gray-300">Custom Q&amp;A pairs <span className="text-gray-500 text-sm">(optional)</span></p>
            {qaFile
              ? <p className="text-sm text-brand-400">{qaFile.name}</p>
              : <p className="text-sm text-gray-500">Text file with "Q: … A: …" format</p>}
          </div>
        </div>

        {error && (
          <div className="bg-red-900/40 border border-red-700 rounded-xl px-4 py-3 text-sm text-red-300">{error}</div>
        )}

        <button type="submit" disabled={!jdFiles.length || busy} className="btn-primary w-full text-base">
          {busy ? (
            <span className="flex items-center justify-center gap-2">
              <Spinner />
              {status === 'uploading' ? 'Uploading…' : 'Generating questions…'}
            </span>
          ) : 'Generate questions & start'}
        </button>
      </form>

      {/* ── Practice questions ── */}
      {questions.length > 0 && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
                Practice questions
              </p>
              {answeredCount > 0 && (
                <p className="text-xs text-gray-500 mt-0.5">
                  {answeredCount}/{questions.length} answered
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={copyQuestions}
                className="text-xs text-brand-400 hover:text-brand-300">
                {copied ? 'Copied!' : 'Copy all'}
              </button>
              <button type="button" onClick={() => setShowBankInput(v => !v)}
                className="text-xs text-gray-400 hover:text-gray-200">Save as bank</button>
              <a href={`${API}/questions/${sessionId}/download`} download
                className="text-xs text-gray-500 hover:text-gray-300">Download</a>
            </div>
          </div>

          {showBankInput && (
            <div className="flex gap-2">
              <input
                type="text"
                value={bankName}
                onChange={e => setBankName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveAsBank()}
                placeholder="Bank name (e.g. Software Engineer)"
                className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-brand-500"
              />
              <button type="button" onClick={saveAsBank} disabled={savingBank || !bankName.trim()}
                className="btn-primary text-xs px-3 py-1.5">
                {savingBank ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}

          <p className="text-xs text-gray-500">Click a question to record your answer with your mic.</p>

          <ol className="space-y-2 text-sm">
            {questions.map((q, i) => {
              const isRecording = activeQ === i
              const isDone = i in answers
              const grade = grades[i]
              const isGrading = grading[i]

              return (
                <li key={i} className="rounded-xl overflow-hidden border border-gray-700">
                  {/* Question row */}
                  <button
                    type="button"
                    onClick={() => toggleQuestion(i)}
                    className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${
                      isRecording
                        ? 'bg-red-900/30 border-red-700'
                        : isDone
                        ? 'bg-green-900/20 hover:bg-green-900/30'
                        : 'hover:bg-gray-800/60'
                    }`}
                  >
                    <span className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold mt-0.5 ${
                      isRecording ? 'bg-red-600 animate-pulse' :
                      isDone ? 'bg-green-600' : 'bg-gray-700 text-gray-400'
                    }`}>
                      {isRecording ? <MicIcon className="w-3 h-3 text-white" /> :
                       isDone ? '✓' : i + 1}
                    </span>
                    <span className={`leading-snug flex-1 ${isDone ? 'text-gray-400' : 'text-gray-200'}`}>{q}</span>
                    {!isRecording && (
                      <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => getSuggestion(i)}
                          disabled={suggesting[i]}
                          title="Get a suggested answer"
                          className="text-xs text-emerald-500 hover:text-emerald-400 disabled:opacity-50 whitespace-nowrap"
                        >
                          {suggesting[i] ? <Spinner /> : 'Answer this'}
                        </button>
                        {!isDone && <MicIcon className="w-4 h-4 text-gray-600 mt-0.5" />}
                      </div>
                    )}
                    {isRecording && (
                      <span className="text-xs text-red-400 shrink-0 mt-0.5">Tap to stop</span>
                    )}
                    {grade && (
                      <span className={`text-xs font-bold shrink-0 mt-0.5 ${
                        grade.score >= 7 ? 'text-green-400' :
                        grade.score >= 4 ? 'text-yellow-400' : 'text-red-400'
                      }`}>{grade.score}/10</span>
                    )}
                    {isGrading && <Spinner />}
                  </button>

                  {/* Live transcript / answer */}
                  {(isRecording || isDone) && answers[i] && (
                    <div className="px-4 py-2 bg-gray-900/50 border-t border-gray-700">
                      <p className="text-xs text-gray-400 italic leading-relaxed">"{answers[i]}"</p>
                    </div>
                  )}

                  {/* Answer suggestion */}
                  {suggestions[i] && (
                    <div className="px-4 py-3 bg-emerald-900/20 border-t border-emerald-800 space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">Suggested answer</p>
                        <button type="button" onClick={() => setSuggestions(prev => { const n={...prev}; delete n[i]; return n })}
                          className="text-xs text-gray-600 hover:text-gray-400">Dismiss</button>
                      </div>
                      <p className="text-xs text-gray-300 leading-relaxed">{suggestions[i]}</p>
                    </div>
                  )}

                  {/* Grade feedback */}
                  {grade && (
                    <div className="px-4 py-3 bg-gray-900/60 border-t border-gray-700 space-y-2">
                      <p className="text-xs text-gray-300">{grade.feedback}</p>
                      {grade.example_answer && (
                        <div className="bg-brand-900/30 border border-brand-800 rounded-lg px-3 py-2 space-y-1">
                          <p className="text-xs font-semibold text-brand-400 uppercase tracking-wide">
                            {grade.score <= 3 ? 'Model answer — what a strong response looks like' : 'Improved version of your answer'}
                          </p>
                          <p className="text-xs text-gray-300 leading-relaxed italic">"{grade.example_answer}"</p>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setAnswers(prev => { const n = { ...prev }; delete n[i]; saveToStorage(questions, sessionId, n, grades); return n })
                          setGrades(prev => { const n = { ...prev }; delete n[i]; saveToStorage(questions, sessionId, answers, n); return n })
                        }}
                        className="text-xs text-gray-600 hover:text-red-400 transition-colors"
                      >
                        ↺ Reset &amp; try again
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>

          {/* Add more documents */}
          <div className="border-t border-gray-700 pt-3 space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Add more context</p>
            <div
              className={`border border-dashed rounded-xl px-4 py-3 text-center cursor-pointer transition-colors ${
                addDrag ? 'border-brand-500 bg-brand-900/10' : 'border-gray-700 hover:border-gray-600'
              }`}
              onClick={() => extraRef.current.click()}
              onDragOver={(e) => { e.preventDefault(); setAddDrag(true) }}
              onDragLeave={() => setAddDrag(false)}
              onDrop={(e) => {
                e.preventDefault()
                setAddDrag(false)
                const files = Array.from(e.dataTransfer.files)
                if (files.length) setExtraFiles(prev => [...prev, ...files])
              }}
            >
              <input ref={extraRef} type="file" multiple className="hidden"
                accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.gif,.webp"
                onChange={(e) => setExtraFiles(prev => [...prev, ...Array.from(e.target.files)])} />
              {extraFiles.length > 0 ? (
                <div className="space-y-1 text-left" onClick={e => e.stopPropagation()}>
                  {extraFiles.map((f, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-brand-400 truncate">{f.name}</span>
                      <button type="button" onClick={() => setExtraFiles(prev => prev.filter((_, j) => j !== i))}
                        className="ml-2 text-gray-600 hover:text-red-400">✕</button>
                    </div>
                  ))}
                  <p className="text-xs text-gray-600 pt-1">Drop more or click to add</p>
                </div>
              ) : (
                <p className="text-xs text-gray-500">Drop or click to add PDFs, images, docs — questions will refresh</p>
              )}
            </div>
            {extraFiles.length > 0 && (
              <button type="button" onClick={handleAddDocuments} disabled={addingDocs}
                className="btn-primary w-full text-sm py-2">
                {addingDocs
                  ? <span className="flex items-center justify-center gap-2"><Spinner /> Refreshing questions…</span>
                  : `Add ${extraFiles.length} file${extraFiles.length > 1 ? 's' : ''} & refresh questions`}
              </button>
            )}
          </div>

          <button type="button"
            onClick={() => { localStorage.removeItem('interview_questions'); setQuestions([]); setAnswers({}); setGrades({}) }}
            className="text-xs text-gray-600 hover:text-gray-400">
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}

function UploadIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

function MicIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}
