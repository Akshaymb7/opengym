// Meals: a photo read by Workers AI, the day's list, the week's totals and the daily targets.
// Present only when the Worker has an AI binding (wrangler.jsonc "ai"), which is also what
// /api/config's `meals` tells the app.
import { json, readBody, text, randomId } from './http.js'
import { readSession } from './session.js'
import { notSignedIn } from './auth.js'
import {
  cleanMeal, cleanGoal, totals, daysEnding, isDay, readAnswer, imageDataUrl,
  PROMPT_SYSTEM, promptUser, ANSWER_SCHEMA
} from './meals.js'

// A 1024 px JPEG is about 150 to 300 KB, a third more as base64. Twice that is the ceiling.
const MAX_IMAGE_CHARS = 1_500_000
const MAX_MEALS_A_DAY = 30
const WEEK = 7

const parse = r => JSON.parse(r.data)
const utcDay = () => new Date().toISOString().slice(0, 10)

/* ---------- photos read per day ---------- */
// Counted before the model runs, atomically, so two photos sent at once cannot both slip under
// the limit. Resolves to the new count, or null when the day's limit is reached.
async function takeAiUse(db, uid, limit) {
  const row = await db.prepare(`INSERT INTO ai_usage (uid, day, n) VALUES (?1, ?2, 1)
    ON CONFLICT(uid, day) DO UPDATE SET n = n + 1 WHERE ai_usage.n < ?3
    RETURNING n`).bind(uid, utcDay(), limit).first()
  return row ? row.n : null
}
async function giveAiUseBack(db, uid) {
  await db.prepare('UPDATE ai_usage SET n = n - 1 WHERE uid = ? AND day = ? AND n > 0').bind(uid, utcDay()).run()
}
async function aiUsed(db, uid) {
  const row = await db.prepare('SELECT n FROM ai_usage WHERE uid = ? AND day = ?').bind(uid, utcDay()).first()
  return row ? row.n : 0
}

// The model, asked for JSON. Some models refuse a schema they cannot meet ("JSON Mode couldn't
// be met"): then once more without it, and the answer is read out of the text (readAnswer).
export async function askModel(env, model, image, hint) {
  const base = {
    messages: [
      { role: 'system', content: PROMPT_SYSTEM },
      { role: 'user', content: [
        { type: 'text', text: promptUser(hint) },
        { type: 'image_url', image_url: { url: image } }
      ] }
    ],
    max_tokens: 1024,
    temperature: 0.2
  }
  try {
    return await env.AI.run(model, { ...base, response_format: { type: 'json_schema', json_schema: ANSWER_SCHEMA } })
  } catch (e) {
    if (!/json/i.test(String(e && e.message))) throw e
    return env.AI.run(model, base)
  }
}

const aiDown = e => {
  const msg = String(e && e.message || e)
  // The free daily allocation used up, or the service refusing: worth saying apart from a bad photo.
  const quota = /neuron|quota|limit|capacity|429|3036|4006/i.test(msg)
  return json(503, {
    error: quota ? 'the free AI allowance for today is used up, try again tomorrow or add the meal by hand' : 'the AI could not be reached, try again',
    code: quota ? 'ai-quota' : 'ai-unavailable'
  })
}

export const mealRoutes = {
  // The day's meals, the targets, the seven days ending that day and today's photo count.
  'GET /api/meals': async ctx => {
    const { db, cfg } = ctx
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const day = ctx.url.searchParams.get('day') || ''
    if (!isDay(day)) return json(400, { error: 'day must be YYYY-MM-DD', code: 'bad-day' })
    const week = daysEnding(day, WEEK)
    const { results } = await db.prepare('SELECT day, data FROM meals WHERE uid = ? AND day BETWEEN ? AND ? ORDER BY day')
      .bind(user.id, week[0], day).all()
    const rows = (results || []).map(parse)
    const meals = rows.filter(m => m.day === day).sort((a, b) => a.at - b.at)
    const byDay = week.map(d => ({ day: d, meals: 0, ...totals(rows.filter(m => m.day === d).flatMap(m => m.items)) }))
    for (const m of rows) { const w = byDay.find(x => x.day === m.day); if (w) w.meals++ }
    const pref = await db.prepare('SELECT data FROM meal_prefs WHERE uid = ?').bind(user.id).first()
    return json(200, {
      day, meals, week: byDay, goal: pref ? parse(pref) : null,
      ai: { used: await aiUsed(db, user.id), limit: cfg.MEALS_AI_DAILY }
    })
  },

  // Save a meal: a new one (no id) or one of this profile's own (its id).
  'POST /api/meals': async ctx => {
    const { db } = ctx
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const body = await readBody(ctx.request)
    const raw = body.meal
    const given = text(raw?.id)
    let id = given
    if (given) {
      const cur = await db.prepare('SELECT uid FROM meals WHERE id = ?').bind(given).first()
      if (!cur || cur.uid !== user.id) return json(404, { error: 'no such meal', code: 'no-meal' })
    } else {
      id = randomId(9)
    }
    const meal = cleanMeal(raw, id)
    if (!meal) return json(400, { error: 'a meal needs a day and at least one food with a name', code: 'bad-meal' })
    if (!given) {
      const n = await db.prepare('SELECT COUNT(*) AS n FROM meals WHERE uid = ? AND day = ?').bind(user.id, meal.day).first()
      if (n.n >= MAX_MEALS_A_DAY) return json(409, { error: 'that day already has the most meals one day can hold', code: 'too-many-meals' })
    }
    await db.prepare('INSERT OR REPLACE INTO meals (id, uid, day, data, updated) VALUES (?, ?, ?, ?, ?)')
      .bind(meal.id, user.id, meal.day, JSON.stringify(meal), Date.now()).run()
    return json(200, { meal })
  },

  'DELETE /api/meals': async ctx => {
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const id = ctx.url.searchParams.get('id') || ''
    const r = await ctx.db.prepare('DELETE FROM meals WHERE id = ? AND uid = ?').bind(id, user.id).run()
    if (!r.meta.changes) return json(404, { error: 'no such meal', code: 'no-meal' })
    return json(200, { ok: true })
  },

  // The daily targets; both empty clears them.
  'PUT /api/meals/goal': async ctx => {
    const { db } = ctx
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const goal = cleanGoal(await readBody(ctx.request))
    if (goal) await db.prepare('INSERT OR REPLACE INTO meal_prefs (uid, data) VALUES (?, ?)').bind(user.id, JSON.stringify(goal)).run()
    else await db.prepare('DELETE FROM meal_prefs WHERE uid = ?').bind(user.id).run()
    return json(200, { goal })
  },

  // A photo in, a list of foods out. Nothing is stored here: the app shows the list to be
  // checked and saves it with POST /api/meals. The photo itself is never kept.
  'POST /api/meals/estimate': async ctx => {
    const { db, cfg, env } = ctx
    const user = await readSession(ctx)
    if (!user) return notSignedIn()
    const body = await readBody(ctx.request)
    const image = imageDataUrl(body.image, MAX_IMAGE_CHARS)
    if (!image) return json(400, { error: 'send the photo as a JPEG, PNG or WebP data URL under 1.5 MB', code: 'bad-image' })
    const used = await takeAiUse(db, user.id, cfg.MEALS_AI_DAILY)
    if (used == null) return json(429, { error: `you have read ${cfg.MEALS_AI_DAILY} photos today, add the meal by hand or try tomorrow`, code: 'ai-daily-limit' })
    let out
    try {
      out = await askModel(env, cfg.AI_MODEL, image, body.hint)
    } catch (e) {
      await giveAiUseBack(db, user.id)
      console.error('meals/estimate', e && e.stack || e)
      return aiDown(e)
    }
    const answer = readAnswer(out)
    if (!answer) {
      console.error('meals/estimate unreadable', JSON.stringify(out).slice(0, 500))
      return json(502, { error: 'the AI answered with something that is not a list of foods, try another photo', code: 'ai-unreadable' })
    }
    // Housekeeping rides along: counts older than a week are of no use.
    await db.prepare('DELETE FROM ai_usage WHERE day < ?').bind(daysEnding(utcDay(), WEEK)[0]).run()
    return json(200, { ...answer, ai: { used, limit: cfg.MEALS_AI_DAILY } })
  }
}
