import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { findModel } from '../models/registry'
import { createReviewViewer, NAMED_VIEWS, type ReviewViewer } from './viewer'
import './LabPage.css'

/**
 * /lab/:model — deterministic model viewer used for img2threejs review captures.
 * Query: ?view=front|hero|right|rear|left|orbit-plus|orbit-minus|rear-quarter|head|head-quarter
 *        &bg=%23ffffff &spin=1 &size=1024 &ground=0 (no contact shadow, for silhouette gates)
 */
export const LabPage = () => {
  const { model: modelId } = useParams()
  const [params] = useSearchParams()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const entry = findModel(modelId)
  const view = params.get('view') ?? 'front'
  const background = params.get('bg') ?? '#ffffff'
  const spin = params.get('spin') === '1'
  const size = Number(params.get('size') ?? 1024)
  const ground = params.get('ground') !== '0'
  const unlit = params.get('unlit') === '1'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !entry) return
    let viewer: ReviewViewer | null = null
    let cancelled = false
    canvas.width = size
    canvas.height = size
    Promise.resolve()
      .then(() => {
        viewer = createReviewViewer(canvas, { background, spin, ground, unlit })
        return entry.load()
      })
      .then((factory) => {
        if (cancelled || !viewer) return
        const model = factory()
        viewer.setModel(model)
        viewer.setCamera(NAMED_VIEWS[view] ?? NAMED_VIEWS.front)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        console.error('[lab] model failed', error)
        setStatus('error')
        setMessage(error instanceof Error ? error.message : 'Model failed to build')
      })
    return () => {
      cancelled = true
      viewer?.dispose()
    }
  }, [entry, view, background, spin, size, ground, unlit])

  if (!entry) return <p className="lab__message">Unknown model.</p>

  return (
    <div className="lab" data-status={status}>
      <canvas ref={canvasRef} className="lab__canvas" style={{ width: size, height: size }} aria-label={`${entry.title} review render`} />
      {status !== 'ready' && <p className="lab__message">{status === 'error' ? message : 'Building model…'}</p>}
    </div>
  )
}
