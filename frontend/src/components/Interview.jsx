import { useState, useEffect, useRef, useCallback } from 'react'
import { Room, RoomEvent, Track, ConnectionState } from 'livekit-client'
import AudioVisualizer from './AudioVisualizer'
import API from '../api'

export default function Interview({ session, onComplete }) {
  const { session_id, questions, livekitToken, livekitUrl } = session

  // LiveKit
  const roomRef = useRef(null)
  const [connState, setConnState] = useState('connecting') // connecting | connected | disconnected
  const [agentStream, setAgentStream] = useState(null)     // remote audio stream (AI speaking)
  const [localStream, setLocalStream] = useState(null)     // local mic stream

  // Interview state
  const [agentSpeaking, setAgentSpeaking] = useState(false)
  const [userSpeaking, setUserSpeaking] = useState(false)
  const [currentQ, setCurrentQ] = useState({ index: 0, text: questions[0] || '' })
  const [answeredCount, setAnsweredCount] = useState(0)
  const [interviewDone, setInterviewDone] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [statusMsg, setStatusMsg] = useState('Connecting to interview room…')

  // Transcript (latest partial)
  const [transcript, setTranscript] = useState('')

  // -------------------------------------------------------------------------
  // Connect to LiveKit room
  // -------------------------------------------------------------------------
  useEffect(() => {
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
    })
    roomRef.current = room

    room.on(RoomEvent.Connected, async () => {
      setConnState('connected')
      setStatusMsg('Connected — waiting for your interviewer…')

      // Enable local mic
      await room.localParticipant.setMicrophoneEnabled(true)
      const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)
      if (micTrack?.track?.mediaStream) {
        setLocalStream(micTrack.track.mediaStream)
      }
    })

    room.on(RoomEvent.Disconnected, () => {
      setConnState('disconnected')
    })

    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Reconnecting) setStatusMsg('Reconnecting…')
    })

    // Remote audio track (AI speech)
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach()
        el.autoplay = true
        document.body.appendChild(el)
        el.style.display = 'none'
        if (track.mediaStream) setAgentStream(track.mediaStream)
      }
    })

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach()
    })

    // Agent speaking / silent detection via audio level
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const agentActive = speakers.some((s) => s.identity !== `candidate-${session_id}`)
      const userActive = speakers.some((s) => s.identity === `candidate-${session_id}`)
      setAgentSpeaking(agentActive)
      setUserSpeaking(userActive)
    })

    // Data messages from agent
    room.on(RoomEvent.DataReceived, (payload) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload))
        handleAgentMessage(msg)
      } catch (_) {}
    })

    room.connect(livekitUrl, livekitToken).catch((err) => {
      console.error('LiveKit connect error', err)
      setConnState('disconnected')
      setStatusMsg('Failed to connect. Please refresh and try again.')
    })

    return () => {
      room.disconnect()
    }
  }, []) // eslint-disable-line

  function handleAgentMessage(msg) {
    switch (msg.type) {
      case 'question_update':
        setCurrentQ({ index: msg.question_index, text: msg.question })
        setStatusMsg(`Question ${msg.question_index + 1} of ${msg.total}`)
        break
      case 'answer_recorded':
        setAnsweredCount(msg.question_index + 1)
        setTranscript('')
        setStatusMsg(`Answer recorded — next question coming…`)
        break
      case 'interview_complete':
        setInterviewDone(true)
        setStatusMsg('Interview complete! Preparing your report…')
        setTimeout(() => onComplete(), 3000)
        break
      default:
        break
    }
  }

  // -------------------------------------------------------------------------
  // Mic toggle
  // -------------------------------------------------------------------------
  const toggleMic = useCallback(async () => {
    const room = roomRef.current
    if (!room) return
    const newMuted = !micMuted
    await room.localParticipant.setMicrophoneEnabled(!newMuted)
    setMicMuted(newMuted)
  }, [micMuted])

  // -------------------------------------------------------------------------
  // Manually end interview (escape hatch)
  // -------------------------------------------------------------------------
  async function handleEndInterview() {
    await fetch(`${API}/complete-interview/${session_id}`, { method: 'POST' })
    onComplete()
  }

  const progress = questions.length > 0 ? (answeredCount / questions.length) * 100 : 0

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="w-full max-w-2xl space-y-6">
      {/* Status bar */}
      <div className="flex items-center justify-between text-sm text-gray-400">
        <span className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connState === 'connected' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400'}`} />
          {statusMsg}
        </span>
        <span>{answeredCount}/{questions.length} answered</span>
      </div>

      {/* Progress */}
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-brand-500 transition-all duration-700 ease-out rounded-full"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Main card */}
      <div className="card space-y-6">
        {/* AI Avatar + Waveform */}
        <div className="flex flex-col items-center gap-4">
          <div className={`relative w-20 h-20 rounded-full flex items-center justify-center
            bg-gradient-to-br from-brand-600 to-brand-900 shadow-lg
            ${agentSpeaking ? 'ring-4 ring-brand-400 ring-offset-2 ring-offset-gray-900' : ''}`}>
            {/* Ripple when speaking */}
            {agentSpeaking && (
              <>
                <span className="absolute inset-0 rounded-full bg-brand-500 opacity-30 animate-ping" />
                <span className="absolute inset-0 rounded-full bg-brand-500 opacity-15 animate-ping" style={{ animationDelay: '0.4s' }} />
              </>
            )}
            <AIFaceIcon className="w-10 h-10 text-white/90" />
          </div>

          <div className="w-full h-14 px-2">
            <AudioVisualizer
              stream={agentStream}
              isActive={agentSpeaking}
              color="#818cf8"
              barCount={40}
            />
          </div>

          <p className="text-xs text-gray-500 uppercase tracking-wider">
            {agentSpeaking ? 'Alex is speaking…' : interviewDone ? 'Interview complete' : 'Listening'}
          </p>
        </div>

        {/* Current question */}
        {currentQ.text && !interviewDone && (
          <div className="bg-gray-800/60 rounded-xl px-5 py-4 border border-gray-700 space-y-1">
            <p className="text-xs text-brand-400 font-semibold uppercase tracking-wide">
              Question {currentQ.index + 1}
            </p>
            <p className="text-gray-100 leading-relaxed">{currentQ.text}</p>
          </div>
        )}

        {interviewDone && (
          <div className="bg-green-900/30 border border-green-700 rounded-xl px-5 py-4 text-center">
            <p className="text-green-300 font-semibold">Interview complete!</p>
            <p className="text-sm text-gray-400 mt-1">Generating your personalised report…</p>
          </div>
        )}

        {/* User mic section */}
        {!interviewDone && (
          <div className="flex flex-col items-center gap-3">
            {/* User waveform */}
            <div className="w-full h-10 px-2">
              <AudioVisualizer
                stream={localStream}
                isActive={userSpeaking && !micMuted}
                color="#34d399"
                barCount={30}
              />
            </div>

            <div className="flex items-center gap-4">
              <button
                onClick={toggleMic}
                className={`w-16 h-16 rounded-full flex items-center justify-center shadow-lg transition-all duration-200
                  ${micMuted
                    ? 'bg-red-700 hover:bg-red-600 ring-2 ring-red-500'
                    : 'bg-gray-700 hover:bg-gray-600 ring-2 ring-gray-600'
                  } ${userSpeaking && !micMuted ? 'ring-green-400 ring-4' : ''}`}
                title={micMuted ? 'Unmute mic' : 'Mute mic'}
              >
                {micMuted ? <MicOffIcon className="w-6 h-6 text-white" /> : <MicIcon className="w-6 h-6 text-white" />}
              </button>
              <p className="text-sm text-gray-400">
                {micMuted ? 'Mic muted — click to unmute' : userSpeaking ? 'Listening…' : 'Your mic is live'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Questions sidebar */}
      <div className="card space-y-2">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">All questions</p>
        <ol className="space-y-1.5">
          {questions.map((q, i) => (
            <li key={i} className={`flex gap-2 text-sm py-1 px-2 rounded-lg transition-colors ${
              i === currentQ.index && !interviewDone ? 'bg-brand-900/40 text-brand-300' :
              i < answeredCount ? 'text-gray-500 line-through' : 'text-gray-400'
            }`}>
              <span className="shrink-0 w-5 text-right">
                {i < answeredCount ? '✓' : `${i + 1}.`}
              </span>
              <span className="leading-snug">{q}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Escape hatch */}
      {!interviewDone && connState === 'connected' && (
        <div className="text-center">
          <button onClick={handleEndInterview} className="text-xs text-gray-600 hover:text-gray-400 transition-colors underline underline-offset-2">
            End interview early & see report
          </button>
        </div>
      )}
    </div>
  )
}

// ---- Icons ----

function AIFaceIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="8" r="5" />
      <path d="M9 21v-2a4 4 0 0 1 6 0v2" />
      <circle cx="9.5" cy="7.5" r="0.5" fill="currentColor" />
      <circle cx="14.5" cy="7.5" r="0.5" fill="currentColor" />
      <path d="M10 10.5s.667.5 2 .5 2-.5 2-.5" strokeLinecap="round" />
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

function MicOffIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}
