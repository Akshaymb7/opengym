// Meals: the pure part. What a meal record may hold, what the AI is asked, and how its answer is
// read back into something safe to store. No I/O here, so every rule has a unit test.

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack']
export const MAX_ITEMS = 20
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const num = (v, max, digits = 0) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0
  const f = 10 ** digits
  return Math.round(Math.min(n, max) * f) / f
}
const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')

export const isDay = d => typeof d === 'string' && DAY_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'))

/** One food line, cleaned: a name, grams and its nutrition, each held to a sane range. Calories
 *  missing but macros given are worked out from them (4 / 4 / 9 kcal per gram). */
export function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = str(raw.name, 60)
  if (!name) return null
  const item = {
    name,
    grams: num(raw.grams, 3000),
    kcal: num(raw.kcal ?? raw.calories, 5000),
    protein: num(raw.protein, 500, 1),
    carbs: num(raw.carbs ?? raw.carbohydrates, 500, 1),
    fat: num(raw.fat, 500, 1)
  }
  if (!item.kcal && (item.protein || item.carbs || item.fat)) {
    item.kcal = Math.round(item.protein * 4 + item.carbs * 4 + item.fat * 9)
  }
  return item
}

export const cleanItems = list => (Array.isArray(list) ? list.map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS) : [])

/** A meal as stored, or null when it cannot be one. `id` is the server's to give a new meal. */
export function cleanMeal(raw, id) {
  if (!raw || typeof raw !== 'object' || !isDay(raw.day)) return null
  const items = cleanItems(raw.items)
  if (!items.length) return null
  const at = Number.isFinite(raw.at) && raw.at > 0 ? Math.round(raw.at) : Date.now()
  return {
    id,
    day: raw.day,
    at,
    slot: SLOTS.includes(raw.slot) ? raw.slot : 'snack',
    items,
    source: raw.source === 'photo' ? 'photo' : 'manual',
    note: str(raw.note, 200)
  }
}

export function totals(items) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  for (const i of items || []) { t.kcal += i.kcal || 0; t.protein += i.protein || 0; t.carbs += i.carbs || 0; t.fat += i.fat || 0 }
  return { kcal: Math.round(t.kcal), protein: Math.round(t.protein), carbs: Math.round(t.carbs), fat: Math.round(t.fat) }
}

export function cleanGoal(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kcal = num(raw.kcal, 10000)
  const protein = num(raw.protein, 1000)
  return kcal || protein ? { kcal, protein } : null
}

/** The `n` calendar days ending with `day`, oldest first. */
export function daysEnding(day, n) {
  const end = Date.parse(day + 'T00:00:00Z')
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86400000).toISOString().slice(0, 10))
}

/* ---------- the photo, as asked of the model ---------- */

export const PROMPT_SYSTEM = [
  'You are a nutrition assistant. You look at a photo of a meal and list each food or drink in it,',
  'with your best estimate of the portion in grams and its calories, protein, carbs and fat for that portion.',
  'Use typical values for the dish as usually prepared, including cooking oil, ghee or butter it is likely made with.',
  'Name dishes the way people call them (for example "dal tadka", "chicken biryani", "chapati"), not their ingredients,',
  'unless the ingredients are served separately. If the photo shows no food, return an empty list.',
  'Answer with JSON only, no other text.'
].join(' ')

export function promptUser(hint) {
  const h = str(hint, 200)
  return [
    'List the foods in this meal photo.',
    h ? `The person who ate it says: "${h}".` : '',
    'Reply with exactly this JSON shape:',
    '{"items":[{"name":"chapati","grams":40,"kcal":120,"protein":3.5,"carbs":20,"fat":3}],"note":"one short sentence on what was hard to judge"}'
  ].filter(Boolean).join(' ')
}

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' }, grams: { type: 'number' }, kcal: { type: 'number' },
          protein: { type: 'number' }, carbs: { type: 'number' }, fat: { type: 'number' }
        },
        required: ['name', 'grams', 'kcal', 'protein', 'carbs', 'fat']
      }
    },
    note: { type: 'string' }
  },
  required: ['items']
}

/** The model's answer as { items, note }, or null when nothing usable came back. Accepts an
 *  already-parsed object (JSON mode), a JSON string, or JSON inside prose or a ``` fence. */
export function readAnswer(out) {
  const v = typeof answerOf(out) === 'string' ? jsonIn(answerOf(out)) : answerOf(out)
  if (!v || typeof v !== 'object') return null
  if (Array.isArray(v)) return { items: cleanItems(v), note: '' }
  const list = [v.items, v.foods].find(Array.isArray)
  return list ? { items: cleanItems(list), note: str(v.note, 200) } : null
}

// What the model said: Workers AI's `response`, or an OpenAI-style message.
function answerOf(out) {
  const v = out && typeof out === 'object' && 'response' in out ? out.response : out
  return v && typeof v === 'object' && Array.isArray(v.choices) ? v.choices[0]?.message?.content : v
}

// The JSON inside a text: an object, or a bare list of foods, whichever bracket opens first.
function jsonIn(s) {
  const o = s.indexOf('{'), a = s.indexOf('[')
  const list = a >= 0 && (o < 0 || a < o)
  const start = list ? a : o
  const end = s.lastIndexOf(list ? ']' : '}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

/** A data URL of a JPEG, PNG or WebP photo, held to `maxChars`. Returns the URL or null. */
export function imageDataUrl(v, maxChars) {
  if (typeof v !== 'string' || v.length > maxChars) return null
  return /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(v) ? v : null
}
