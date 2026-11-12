import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEnv, call, signup, fakeAI } from './helpers.js'
import { cleanItem, cleanMeal, readAnswer, totals, daysEnding, cleanGoal, imageDataUrl, isDay } from '../src/meals.js'

const PW = 'correct horse battery'
const PHOTO = 'data:image/jpeg;base64,' + 'A'.repeat(400)
const ANSWER = { items: [{ name: 'Chapati', grams: 80, kcal: 240, protein: 7, carbs: 40, fat: 6 }, { name: 'Dal tadka', grams: 200, kcal: 260, protein: 12, carbs: 30, fat: 9 }], note: 'Oil is a guess.' }

/* ---------- the pure part ---------- */

test('a food line is held to sane ranges, and calories come from macros when missing', () => {
  assert.deepEqual(cleanItem({ name: '  Paneer   tikka ', grams: '150', kcal: 330.6, protein: 18.26, carbs: 8, fat: 24 }),
    { name: 'Paneer tikka', grams: 150, kcal: 331, protein: 18.3, carbs: 8, fat: 24 })
  assert.equal(cleanItem({ name: 'Rice', grams: 150, protein: 4, carbs: 40, fat: 0.5 }).kcal, 181)
  assert.equal(cleanItem({ name: 'x', grams: -5, kcal: 1e9 }).kcal, 5000)
  assert.equal(cleanItem({ name: 'x', grams: -5 }).grams, 0)
  assert.equal(cleanItem({ grams: 10 }), null)
  assert.equal(cleanItem('rice'), null)
  assert.equal(cleanItem({ name: 'Curd', calories: 60, carbohydrates: 5 }).kcal, 60)
})

test('a meal needs a real day and one named food; slot and source fall back', () => {
  assert.equal(cleanMeal({ day: '2026-13-40', items: [{ name: 'a' }] }, 'id1'), null)
  assert.equal(cleanMeal({ day: '2026-11-12', items: [] }, 'id1'), null)
  const m = cleanMeal({ day: '2026-11-12', at: 1700000000000, slot: 'brunch', source: 'x', items: [{ name: 'Idli', kcal: 70 }], note: 'n' }, 'id1')
  assert.equal(m.id, 'id1')
  assert.equal(m.slot, 'snack')
  assert.equal(m.source, 'manual')
  assert.equal(m.at, 1700000000000)
  assert.equal(cleanMeal({ day: '2026-11-12', slot: 'lunch', source: 'photo', items: [{ name: 'a' }] }, 'i').slot, 'lunch')
})

test('the model answer is read from an object, a string, a fence or the OpenAI shape', () => {
  assert.equal(readAnswer({ response: ANSWER }).items.length, 2)
  assert.equal(readAnswer({ response: 'Sure! ```json\n' + JSON.stringify(ANSWER) + '\n``` Enjoy.' }).note, 'Oil is a guess.')
  assert.equal(readAnswer({ choices: [{ message: { content: JSON.stringify(ANSWER) } }] }).items[1].name, 'Dal tadka')
  assert.equal(readAnswer({ response: JSON.stringify(ANSWER.items) }).items.length, 2)
  assert.deepEqual(readAnswer({ response: '{"items":[]}' }), { items: [], note: '' })
  assert.equal(readAnswer({ response: 'I cannot see any food.' }), null)
  assert.equal(readAnswer({ response: '{not json}' }), null)
  assert.equal(readAnswer(null), null)
})

test('totals, goals, days and photos', () => {
  assert.deepEqual(totals(ANSWER.items), { kcal: 500, protein: 19, carbs: 70, fat: 15 })
  assert.deepEqual(daysEnding('2026-03-01', 3), ['2026-02-27', '2026-02-28', '2026-03-01'])
  assert.equal(cleanGoal({ kcal: 0, protein: 0 }), null)
  assert.deepEqual(cleanGoal({ kcal: '2200', protein: 140.4 }), { kcal: 2200, protein: 140 })
  assert.equal(imageDataUrl(PHOTO, 10000), PHOTO)
  assert.equal(imageDataUrl(PHOTO, 100), null)
  assert.equal(imageDataUrl('data:image/gif;base64,AAAA', 1000), null)
  assert.equal(imageDataUrl('data:image/png;base64,AA AA', 1000), null)
  assert.equal(isDay('2026-02-30'), true) // Date.parse rolls over; the shape is what is checked
  assert.equal(isDay('26-02-03'), false)
})

/* ---------- the routes ---------- */

test('without an AI binding Meals is not there', async () => {
  const env = makeEnv()
  const me = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  assert.equal((await call(env, 'GET', '/api/config', { as: me })).body.meals, undefined)
  assert.equal((await call(env, 'GET', '/api/meals?day=2026-11-12', { as: me })).status, 404)
})

test('a photo is read, checked, saved, listed with its week, edited and deleted', async () => {
  const ai = fakeAI({ response: ANSWER })
  const env = makeEnv({ AI: ai })
  const me = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  assert.equal((await call(env, 'GET', '/api/config', { as: me })).body.meals, true)
  assert.equal((await call(env, 'GET', '/api/config')).body.meals, undefined, 'only for a session')
  assert.equal((await call(env, 'POST', '/api/meals/estimate', { body: { image: PHOTO } })).status, 401)

  const est = await call(env, 'POST', '/api/meals/estimate', { as: me, body: { image: PHOTO, hint: 'home made' } })
  assert.equal(est.status, 200)
  assert.equal(est.body.items.length, 2)
  assert.deepEqual(est.body.ai, { used: 1, limit: 20 })
  const input = ai.calls[0].input
  assert.equal(ai.calls[0].model, '@cf/meta/llama-4-scout-17b-16e-instruct')
  assert.equal(input.messages[1].content[1].image_url.url, PHOTO)
  assert.match(input.messages[1].content[0].text, /home made/)
  assert.equal(input.response_format.type, 'json_schema')

  const saved = await call(env, 'POST', '/api/meals', { as: me, body: { meal: { day: '2026-11-12', slot: 'lunch', source: 'photo', items: est.body.items } } })
  assert.equal(saved.status, 200)
  const id = saved.body.meal.id
  await call(env, 'POST', '/api/meals', { as: me, body: { meal: { day: '2026-11-10', slot: 'dinner', items: [{ name: 'Oats', kcal: 300, protein: 10 }] } } })
  await call(env, 'PUT', '/api/meals/goal', { as: me, body: { kcal: 2200, protein: 140 } })

  const day = await call(env, 'GET', '/api/meals?day=2026-11-12', { as: me })
  assert.equal(day.body.meals.length, 1)
  assert.deepEqual(day.body.goal, { kcal: 2200, protein: 140 })
  assert.equal(day.body.week.length, 7)
  assert.equal(day.body.week[6].kcal, 500)
  assert.equal(day.body.week[4].kcal, 300)
  assert.equal(day.body.week[4].meals, 1)
  assert.deepEqual(day.body.ai, { used: 1, limit: 20 })
  assert.equal((await call(env, 'GET', '/api/meals?day=12-11-2026', { as: me })).body.code, 'bad-day')

  const edited = await call(env, 'POST', '/api/meals', { as: me, body: { meal: { id, day: '2026-11-12', slot: 'lunch', items: [{ name: 'Chapati', kcal: 120 }] } } })
  assert.equal(edited.body.meal.id, id)
  assert.equal((await call(env, 'GET', '/api/meals?day=2026-11-12', { as: me })).body.week[6].kcal, 120)

  assert.equal((await call(env, 'POST', '/api/meals', { as: me, body: { meal: { day: '2026-11-12', items: [] } } })).body.code, 'bad-meal')
  assert.equal((await call(env, 'DELETE', '/api/meals?id=' + id, { as: me })).status, 200)
  assert.equal((await call(env, 'DELETE', '/api/meals?id=' + id, { as: me })).status, 404)
  assert.equal((await call(env, 'PUT', '/api/meals/goal', { as: me, body: {} })).body.goal, null)
})

test('one profile cannot see, edit or delete another one\'s meal, and meals go with the profile', async () => {
  const env = makeEnv({ AI: fakeAI({ response: ANSWER }) })
  const owner = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const code = (await call(env, 'POST', '/api/admin/invites/new', { as: owner, body: {} })).body.invite.code
  const friend = await signup(env, 'Rahul', 'squat deep every day', code)
  const mine = (await call(env, 'POST', '/api/meals', { as: owner, body: { meal: { day: '2026-11-12', items: [{ name: 'Egg', kcal: 70 }] } } })).body.meal
  assert.equal((await call(env, 'GET', '/api/meals?day=2026-11-12', { as: friend })).body.meals.length, 0)
  assert.equal((await call(env, 'POST', '/api/meals', { as: friend, body: { meal: { ...mine, items: [{ name: 'Hacked', kcal: 1 }] } } })).status, 404)
  assert.equal((await call(env, 'DELETE', '/api/meals?id=' + mine.id, { as: friend })).status, 404)

  await call(env, 'POST', '/api/meals', { as: friend, body: { meal: { day: '2026-11-12', items: [{ name: 'Toast', kcal: 90 }] } } })
  await call(env, 'POST', '/api/account/delete', { as: friend, body: { name: 'Rahul', current: 'squat deep every day' } })
  const left = env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM meals').get().n
  assert.equal(left, 1, 'only the owner\'s meal is left')
})

test('photos read a day are limited, a failed read is given back, and bad answers are refused', async () => {
  let mode = 'ok'
  const ai = fakeAI(() => mode === 'ok' ? { response: ANSWER }
    : mode === 'quota' ? new Error('AiError: 4006: you have used up your daily free allocation of 10,000 neurons')
    : mode === 'down' ? new Error('network connection lost')
    : { response: 'There is a plate.' })
  const env = makeEnv({ AI: ai, MEALS_AI_DAILY: '2' })
  const me = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const read = () => call(env, 'POST', '/api/meals/estimate', { as: me, body: { image: PHOTO } })

  assert.equal((await call(env, 'POST', '/api/meals/estimate', { as: me, body: { image: 'data:text/plain;base64,AAAA' } })).body.code, 'bad-image')
  mode = 'quota'
  assert.equal((await read()).body.code, 'ai-quota')
  mode = 'down'
  assert.equal((await read()).body.code, 'ai-unavailable')
  mode = 'junk'
  assert.equal((await read()).body.code, 'ai-unreadable')
  mode = 'ok'
  assert.equal((await read()).status, 200)
  const capped = await read()
  assert.equal(capped.status, 429)
  assert.equal(capped.body.code, 'ai-daily-limit')
  assert.equal(ai.calls.length, 4, 'the capped photo never reached the model')
})

test('a model that refuses the JSON schema is asked once more without it', async () => {
  const ai = fakeAI((input, n) => n === 1 ? new Error("JSON Mode couldn't be met") : { response: JSON.stringify(ANSWER) })
  const env = makeEnv({ AI: ai })
  const me = await signup(env, 'Akshay', PW, 'SETUP-CODE-1')
  const r = await call(env, 'POST', '/api/meals/estimate', { as: me, body: { image: PHOTO } })
  assert.equal(r.status, 200)
  assert.equal(ai.calls.length, 2)
  assert.equal(ai.calls[1].input.response_format, undefined)
})
