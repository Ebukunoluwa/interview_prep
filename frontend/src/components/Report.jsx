import { useState, useEffect } from 'react'
import API from '../api'

export default function Report({ sessionId, onRestart }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retries, setRetries] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function fetchReport() {
      try {
        const res = await fetch(`${API}/report/${sessionId}`)
        if (!res.ok) throw new Error(await res.text())
        const data = await res.json()
        if (!cancelled) {
          setReport(data)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          if (retries < 5) {
            // Grades may still be coming in — retry
            setTimeout(() => setRetries((r) => r + 1), 2000)
          } else {
            setError(err.message || 'Failed to load report')
            setLoading(false)
          }
        }
      }
    }
    fetchReport()
    return () => { cancelled = true }
  }, [sessionId, retries])

  if (loading) return <LoadingState />
  if (error) return <ErrorState message={error} onRestart={onRestart} />

  const { overall_score, grades, strengths, improvements, coaching_summary, questions } = report

  return (
    <div className="w-full max-w-2xl space-y-6 pb-16">
      {/* Header */}
      <div className="text-center space-y-1">
        <h1 className="text-3xl font-bold">Your Interview Report</h1>
        <p className="text-gray-400 text-sm">Here's how you did — honest feedback to help you improve.</p>
      </div>

      {/* Overall score */}
      <div className="card flex items-center gap-6">
        <ScoreDial score={overall_score} max={10} size={88} />
        <div className="space-y-2 flex-1">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Overall score</p>
          <p className="text-2xl font-bold">
            {overall_score}
            <span className="text-gray-500 font-normal text-base"> / 10</span>
          </p>
          <p className="text-sm text-gray-300 leading-relaxed">{coaching_summary}</p>
        </div>
      </div>

      {/* Strengths & improvements */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card space-y-2">
          <p className="text-xs font-semibold text-green-400 uppercase tracking-wide flex items-center gap-1.5">
            <ThumbUpIcon className="w-3.5 h-3.5" /> Strengths
          </p>
          <ul className="space-y-1.5 text-sm text-gray-300">
            {strengths.length > 0
              ? strengths.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-green-500 shrink-0">✓</span> {s}
                  </li>
                ))
              : <li className="text-gray-500 italic">Keep practicing to build strengths!</li>
            }
          </ul>
        </div>
        <div className="card space-y-2">
          <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide flex items-center gap-1.5">
            <LightbulbIcon className="w-3.5 h-3.5" /> To improve
          </p>
          <ul className="space-y-1.5 text-sm text-gray-300">
            {improvements.length > 0
              ? improvements.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-amber-500 shrink-0">→</span> {s}
                  </li>
                ))
              : <li className="text-gray-500 italic">Great job overall!</li>
            }
          </ul>
        </div>
      </div>

      {/* Per-question breakdown */}
      <div className="space-y-3">
        <p className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
          Question breakdown
        </p>
        {grades.map((g, i) => (
          <QuestionCard key={i} grade={g} number={i + 1} />
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 justify-center pt-2">
        <button
          onClick={() => window.print()}
          className="btn-ghost flex items-center gap-2 text-sm"
        >
          <PrintIcon className="w-4 h-4" /> Save / Print
        </button>
        <button onClick={onRestart} className="btn-primary flex items-center gap-2 text-sm">
          <RefreshIcon className="w-4 h-4" /> Practice again
        </button>
      </div>
    </div>
  )
}

// ---- Sub-components ----

function QuestionCard({ grade, number }) {
  const [open, setOpen] = useState(false)
  const scoreColor =
    grade.score >= 8 ? 'text-green-400' :
    grade.score >= 5 ? 'text-amber-400' : 'text-red-400'

  return (
    <div className="card space-y-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-start gap-3 text-left"
      >
        <span className={`text-2xl font-bold tabular-nums shrink-0 ${scoreColor}`}>
          {grade.score}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-500 mb-0.5">Question {number}</p>
          <p className="text-sm text-gray-200 leading-snug line-clamp-2">{grade.question}</p>
        </div>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div className="space-y-3 pt-2 border-t border-gray-800">
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Your answer</p>
            <p className="text-sm text-gray-300 leading-relaxed italic">
              "{grade.answer || 'No transcript recorded'}"
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Feedback</p>
            <p className="text-sm text-gray-300 leading-relaxed">{grade.feedback}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-xs font-semibold text-green-500 mb-1">Strengths</p>
              <ul className="text-xs text-gray-400 space-y-0.5">
                {(grade.strengths || []).map((s, i) => <li key={i}>• {s}</li>)}
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold text-amber-500 mb-1">Improvements</p>
              <ul className="text-xs text-gray-400 space-y-0.5">
                {(grade.improvements || []).map((s, i) => <li key={i}>• {s}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ScoreDial({ score, max = 10, size = 80 }) {
  const pct = score / max
  const r = (size - 12) / 2
  const circ = 2 * Math.PI * r
  const offset = circ * (1 - pct)

  const color = score >= 8 ? '#4ade80' : score >= 5 ? '#fbbf24' : '#f87171'

  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1f2937" strokeWidth="8" />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none"
        stroke={color}
        strokeWidth="8"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 1s ease-out' }}
      />
    </svg>
  )
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center gap-4 py-20">
      <div className="w-12 h-12 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
      <p className="text-gray-400">Generating your report…</p>
    </div>
  )
}

function ErrorState({ message, onRestart }) {
  return (
    <div className="card max-w-md mx-auto text-center space-y-4">
      <p className="text-red-400 font-semibold">Failed to load report</p>
      <p className="text-sm text-gray-400">{message}</p>
      <button onClick={onRestart} className="btn-primary">Start over</button>
    </div>
  )
}

// ---- Icons ----

function ChevronIcon({ open }) {
  return (
    <svg className={`w-4 h-4 text-gray-500 shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
function ThumbUpIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
      <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </svg>
  )
}
function LightbulbIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="9" y1="18" x2="15" y2="18" />
      <line x1="10" y1="22" x2="14" y2="22" />
      <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
    </svg>
  )
}
function PrintIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  )
}
function RefreshIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 .49-4.88" />
    </svg>
  )
}
