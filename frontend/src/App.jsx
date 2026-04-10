import { useState } from 'react'
import Upload from './components/Upload'
import Interview from './components/Interview'
import Report from './components/Report'
import AssistantListener from './components/AssistantListener'

const VIEWS = { UPLOAD: 'upload', INTERVIEW: 'interview', REPORT: 'report' }

export default function App() {
  const [view, setView] = useState(VIEWS.UPLOAD)
  const [session, setSession] = useState(null)
  const [assistantSessionId, setAssistantSessionId] = useState(null)

  function handleUploadComplete(sessionData) {
    setSession(sessionData)
    setAssistantSessionId(sessionData.session_id)
    setView(VIEWS.INTERVIEW)
  }

  // Called from Upload when a session is ready (questions generated)
  function handleSessionReady(session_id) {
    setAssistantSessionId(session_id)
  }

  function handleInterviewComplete() {
    setView(VIEWS.REPORT)
  }

  function handleRestart() {
    setSession(null)
    setView(VIEWS.UPLOAD)
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center">
          <MicIcon className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-lg tracking-tight">Interview Coach</span>
        <span className="ml-auto text-xs text-gray-500">Powered by Llama 3.3 · Deepgram · LiveKit</span>
      </header>

      {/* Progress dots */}
      {view !== VIEWS.UPLOAD && (
        <div className="flex items-center justify-center gap-2 py-3 border-b border-gray-800">
          {[VIEWS.UPLOAD, VIEWS.INTERVIEW, VIEWS.REPORT].map((v, i) => (
            <div
              key={v}
              className={`h-2 rounded-full transition-all duration-300 ${
                v === view
                  ? 'w-8 bg-brand-500'
                  : view === VIEWS.REPORT && i < 2
                  ? 'w-2 bg-brand-700'
                  : 'w-2 bg-gray-700'
              }`}
            />
          ))}
        </div>
      )}

      {/* Always-on assistant — available once a session exists */}
      <AssistantListener sessionId={assistantSessionId} />

      {/* Main */}
      <main className="flex-1 flex items-start justify-center px-4 py-10">
        {view === VIEWS.UPLOAD && (
          <Upload onComplete={handleUploadComplete} onSessionReady={handleSessionReady} />
        )}
        {view === VIEWS.INTERVIEW && session && (
          <Interview session={session} onComplete={handleInterviewComplete} />
        )}
        {view === VIEWS.REPORT && session && (
          <Report sessionId={session.session_id} onRestart={handleRestart} />
        )}
      </main>
    </div>
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
