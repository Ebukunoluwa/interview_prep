import { useEffect, useRef } from 'react'

/**
 * Canvas-based audio waveform visualizer.
 *
 * Props:
 *   stream     — MediaStream | null  (local or remote)
 *   isActive   — boolean             (whether to draw the animation)
 *   color      — hex / css string    (bar colour)
 *   barCount   — number of bars
 */
export default function AudioVisualizer({
  stream,
  isActive = false,
  color = '#6366f1',
  barCount = 32,
}) {
  const canvasRef = useRef(null)
  const animRef = useRef(null)
  const analyserRef = useRef(null)
  const sourceRef = useRef(null)
  const ctxRef = useRef(null)

  useEffect(() => {
    if (!stream || !isActive) {
      cancelAnimationFrame(animRef.current)
      drawIdle()
      return
    }

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    ctxRef.current = audioCtx

    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = barCount * 2
    analyserRef.current = analyser

    const source = audioCtx.createMediaStreamSource(stream)
    source.connect(analyser)
    sourceRef.current = source

    const data = new Uint8Array(analyser.frequencyBinCount)

    function draw() {
      animRef.current = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(data)

      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      const { width, height } = canvas
      ctx.clearRect(0, 0, width, height)

      const barWidth = width / data.length - 1
      data.forEach((val, i) => {
        const barHeight = (val / 255) * height * 0.85 + 2
        const x = i * (barWidth + 1)
        const y = (height - barHeight) / 2
        ctx.fillStyle = color
        ctx.globalAlpha = 0.85
        roundRect(ctx, x, y, barWidth, barHeight, barWidth / 2)
        ctx.fill()
      })
      ctx.globalAlpha = 1
    }

    draw()

    return () => {
      cancelAnimationFrame(animRef.current)
      source.disconnect()
      audioCtx.close()
    }
  }, [stream, isActive, color, barCount])

  function drawIdle() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    ctx.clearRect(0, 0, width, height)

    const barWidth = width / barCount - 1
    for (let i = 0; i < barCount; i++) {
      const barHeight = 4
      const x = i * (barWidth + 1)
      const y = (height - barHeight) / 2
      ctx.fillStyle = '#374151'
      roundRect(ctx, x, y, barWidth, barHeight, barWidth / 2)
      ctx.fill()
    }
  }

  useEffect(() => {
    if (!isActive) drawIdle()
  }, [isActive])

  return (
    <canvas
      ref={canvasRef}
      width={300}
      height={60}
      className="w-full h-full"
    />
  )
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
