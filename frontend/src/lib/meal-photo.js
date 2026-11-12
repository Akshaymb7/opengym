// A meal photo, made small enough to send to the server's AI (worker/src/routes-meals.js): drawn
// again on a canvas at most EDGE px on its long side, as a JPEG data URL. Drawing it again also
// drops the EXIF block, so the location a phone wrote into the photo never leaves the device.
// The photo is not kept anywhere: only what the AI read from it is saved.
import { decodeImage } from './media-ingest.js'

const EDGE = 1024
// The server refuses more than 1.5 MB of base64; stepping the quality down stays well under it.
const MAX_CHARS = 1_400_000

const readAsDataUrl = blob => new Promise((resolve, reject) => {
  const fr = new FileReader()
  fr.onload = () => resolve(String(fr.result))
  fr.onerror = () => reject(fr.error || new Error('unreadable'))
  fr.readAsDataURL(blob)
})
const toJpeg = (canvas, q) => new Promise(resolve => {
  try { canvas.toBlob(b => resolve(b), 'image/jpeg', q) } catch { resolve(null) }
})

/** `file` as a JPEG data URL of at most EDGE px. Throws MediaError('unreadable') for a photo this
 *  browser cannot open (a HEIC outside Safari, a file that is not a photo). */
export async function mealPhotoDataUrl(file, { doc = globalThis.document } = {}) {
  const pic = await decodeImage(file, file.type || 'image/jpeg', { doc })
  const canvas = doc.createElement('canvas')
  try {
    const scale = Math.min(1, EDGE / Math.max(pic.width, pic.height))
    canvas.width = Math.max(1, Math.round(pic.width * scale))
    canvas.height = Math.max(1, Math.round(pic.height * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(pic.source, 0, 0, canvas.width, canvas.height)
    for (const q of [0.82, 0.7, 0.55]) {
      const blob = await toJpeg(canvas, q)
      if (!blob) break
      const url = await readAsDataUrl(blob)
      if (url.length <= MAX_CHARS) return url
    }
    throw new Error('unreadable')
  } finally {
    pic.close()
    canvas.width = 0
    canvas.height = 0
  }
}
