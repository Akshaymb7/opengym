// Meals (views/Meals.jsx): the arithmetic behind the screen. Pure, so each rule has a test.
// The meals themselves live on the server (worker/src/routes-meals.js), not in the profile's
// synced document: food never touches the training sync.

/* The four parts of a day, in order. `label` is an English key, translated where shown. */
export const SLOTS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'snack', label: 'Snack' },
  { id: 'dinner', label: 'Dinner' },
]
export const SLOT_LABEL = Object.fromEntries(SLOTS.map(s => [s.id, s.label]))

/** The part of the day a meal eaten at `date` most likely is. */
export function slotFor(date = new Date()) {
  const h = date.getHours()
  if (h >= 4 && h < 11) return 'breakfast'
  if (h >= 11 && h < 16) return 'lunch'
  if (h >= 18 && h < 23) return 'dinner'
  return 'snack'
}

const r1 = n => Math.round(n * 10) / 10
const pos = n => (Number.isFinite(n) && n > 0 ? n : 0)

/** `item` at a new weight: calories and macros scale with the grams the AI first guessed, so
 *  correcting a portion keeps what it is made of. With no grams to scale from, only grams change. */
export function scaleItem(item, grams) {
  const g = pos(grams)
  const from = pos(item.grams)
  if (!from) return { ...item, grams: Math.round(g) }
  const k = g / from
  return {
    ...item,
    grams: Math.round(g),
    kcal: Math.round(pos(item.kcal) * k),
    protein: r1(pos(item.protein) * k),
    carbs: r1(pos(item.carbs) * k),
    fat: r1(pos(item.fat) * k),
  }
}

export function mealTotals(items) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  for (const i of items || []) { t.kcal += pos(i.kcal); t.protein += pos(i.protein); t.carbs += pos(i.carbs); t.fat += pos(i.fat) }
  return { kcal: Math.round(t.kcal), protein: Math.round(t.protein), carbs: Math.round(t.carbs), fat: Math.round(t.fat) }
}

/** The day `n` days from `day` (YYYY-MM-DD), by the calendar. */
export function addDays(day, n) {
  const d = new Date(day + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** Average calories of the days in `week` that have anything logged; null when none has. A day
 *  with nothing logged is a day not tracked, not a day of fasting. */
export function weekAverage(week) {
  const logged = (week || []).filter(d => d.meals > 0)
  if (!logged.length) return null
  return { kcal: Math.round(logged.reduce((s, d) => s + d.kcal, 0) / logged.length), protein: Math.round(logged.reduce((s, d) => s + d.protein, 0) / logged.length), days: logged.length }
}

/** How far into a target: { pct (0..100+), left (may be negative: over) }, or null with no target. */
export function progress(value, target) {
  if (!(target > 0)) return null
  return { pct: Math.round((value / target) * 100), left: Math.round(target - value) }
}

/** Body weight across `from`..`to` (S.bodyweight entries { d, w }): the first and last weigh-in in
 *  the range and the change between them, or null with fewer than two. */
export function weightChange(bodyweight, from, to) {
  const inRange = (bodyweight || []).filter(b => b && b.d >= from && b.d <= to && Number.isFinite(b.w)).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  if (inRange.length < 2) return null
  const first = inRange[0], last = inRange[inRange.length - 1]
  return { from: first.w, to: last.w, change: r1(last.w - first.w), days: Math.round((Date.parse(last.d) - Date.parse(first.d)) / 86400000) }
}

/** A blank food line for adding by hand. */
export const emptyItem = () => ({ name: '', grams: 0, kcal: 0, protein: 0, carbs: 0, fat: 0 })

/** The lines worth saving: named ones, with numbers that are numbers. */
export const savableItems = items => (items || []).filter(i => i && typeof i.name === 'string' && i.name.trim())
  .map(i => ({ name: i.name.trim(), grams: pos(i.grams), kcal: pos(i.kcal), protein: pos(i.protein), carbs: pos(i.carbs), fat: pos(i.fat) }))
