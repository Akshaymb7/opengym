// Meals: a photo of what you eat, read by the server's AI (worker/src/routes-meals.js), checked by
// you, then saved. The day's calories and protein against your targets, and the week beside your
// weigh-ins. Shown only where the server says it has Meals (GET /api/config `meals`).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { todayISO, fmtDate, fmtNum, DAYS } from '../lib/format.js'
import {
  SLOTS, SLOT_LABEL, slotFor, scaleItem, mealTotals, addDays, weekAverage, progress,
  weightChange, emptyItem, savableItems,
} from '../lib/meals.js'
import { mealPhotoDataUrl } from '../lib/meal-photo.js'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, Segmented, TextField } from '../components/ui.jsx'
import { confirmSheet } from '../sheets.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const kcalText = n => t('{0} kcal', Math.round(n).toLocaleString())
const gramsText = n => t('{0} g', Math.round(n))
const timeOf = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// The server's refusals, in the app's words where we have them.
function problem(e) {
  const code = e?.data?.code
  if (code === 'ai-quota') return t('The free AI allowance for today is used up. Add the meal by hand, or try again tomorrow.')
  if (code === 'ai-daily-limit') return t('That is all the photos you can read today. Add the meal by hand, or try again tomorrow.')
  if (code === 'ai-unreadable') return t('The AI could not make a list of foods from that photo. Try another one, closer and from above.')
  if (code === 'ai-unavailable') return t('The AI could not be reached. Try again in a moment.')
  if (e?.message === 'unreadable' || e?.code === 'unreadable') return t('This photo could not be opened. Try a JPEG or PNG.')
  return e?.message || t('Something went wrong. Try again.')
}

/* ---------------------------------------------------------------- the meal sheet */

let rowKey = 0
const row = item => ({ key: ++rowKey, item, base: item })

function MealSheet({ meal, note, onSaved, close }) {
  const [slot, setSlot] = useState(meal.slot || slotFor())
  const [rows, setRows] = useState(() => (meal.items?.length ? meal.items : [emptyItem()]).map(row))
  const [busy, setBusy] = useState(false)
  const total = mealTotals(rows.map(r => r.item))

  const change = (key, fn) => setRows(rs => rs.map(r => (r.key === key ? fn(r) : r)))
  // A new portion scales from what the line held before it was changed by hand.
  const setGrams = (key, g) => change(key, r => ({ ...r, item: { ...scaleItem(r.base, g), name: r.item.name } }))
  const setField = (key, f, v) => change(key, r => {
    const item = { ...r.item, [f]: v }
    return { ...r, item, base: f === 'name' ? { ...r.base, name: v } : item }
  })
  const remove = key => setRows(rs => rs.filter(r => r.key !== key))

  const save = async () => {
    const items = savableItems(rows.map(r => r.item))
    if (!items.length) { toast(t('Add at least one food with a name.')); return }
    setBusy(true)
    try {
      const body = { meal: { id: meal.id, day: meal.day, at: meal.at || Date.now(), slot, items, source: meal.source || 'manual', note: meal.note || '' } }
      await api('/api/meals', { method: 'POST', body: JSON.stringify(body) })
      close(); onSaved()
      toast(meal.id ? t('Meal saved') : t('Meal added'))
    } catch (e) { toast(problem(e)) } finally { setBusy(false) }
  }
  const del = () => confirmSheet({
    title: t('Delete this meal?'), confirmText: t('Delete'), danger: true,
    onConfirm: async () => {
      try { await api('/api/meals?id=' + encodeURIComponent(meal.id), { method: 'DELETE' }); close(); onSaved(); toast(t('Meal deleted')) }
      catch (e) { toast(problem(e)) }
    },
  })

  return <>
    <h3>{meal.id ? t('Edit meal') : meal.source === 'photo' ? t('Check what the AI saw') : t('Add a meal')}</h3>
    {meal.source === 'photo' && !meal.id && <div className="muted small" style={{ marginBottom: 10 }}>
      {t('These are estimates. Fix the names and grams: calories and macros follow the grams.')}
      {note ? <div className="dim" style={{ marginTop: 4 }}>{note}</div> : null}
    </div>}
    <Segmented value={slot} onChange={setSlot} options={SLOTS.map(s => ({ value: s.id, label: t(s.label) }))} />
    <div style={{ height: 12 }} />
    {rows.map(r => <div key={r.key} className="card" style={{ padding: 10, margin: '0 0 8px' }}>
      <div className="row" style={{ gap: 8 }}>
        <TextField value={r.item.name} placeholder={t('Food')} aria-label={t('Food')} style={{ flex: 1 }}
          onChange={e => setField(r.key, 'name', e.target.value)} />
        <button type="button" className="iconbtn" style={{ color: 'var(--red)' }} onClick={() => remove(r.key)} aria-label={t('Remove')}><Icon name="trash" /></button>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <label className="small muted" style={{ flex: 1 }}>{t('Grams')}
          <NumberField decimal={false} value={r.item.grams} onChange={v => setGrams(r.key, v)} aria-label={t('Grams')} /></label>
        <label className="small muted" style={{ flex: 1 }}>{t('kcal')}
          <NumberField decimal={false} value={r.item.kcal} onChange={v => setField(r.key, 'kcal', v)} aria-label={t('kcal')} /></label>
        <label className="small muted" style={{ flex: 1 }}>{t('Protein (g)')}
          <NumberField value={r.item.protein} onChange={v => setField(r.key, 'protein', v)} aria-label={t('Protein (g)')} /></label>
      </div>
      <div className="small dim" style={{ marginTop: 6 }}>{t('Carbs {0} g · Fat {1} g', fmtNum(r.item.carbs || 0), fmtNum(r.item.fat || 0))}</div>
    </div>)}
    <Button size="sm" variant="ghost" icon="plus" onClick={() => setRows(rs => [...rs, row(emptyItem())])}>{t('Add a food')}</Button>
    <div className="row between" style={{ margin: '12px 2px' }}>
      <b>{kcalText(total.kcal)}</b>
      <span className="small muted">{t('Protein {0} g · Carbs {1} g · Fat {2} g', total.protein, total.carbs, total.fat)}</span>
    </div>
    <Button variant="primary" disabled={busy} onClick={save}>{t('Save meal')}</Button>
    {meal.id && <><div style={{ height: 8 }} /><button type="button" className="btn danger" disabled={busy} onClick={del}>{t('Delete meal')}</button></>}
  </>
}

const mealSheet = (meal, onSaved, note) => ui().openSheet(close => <MealSheet meal={meal} note={note} onSaved={onSaved} close={close} />)

/* ---------------------------------------------------------------- targets */

function GoalSheet({ goal, onSaved, close }) {
  const [kcal, setKcal] = useState(goal?.kcal || 0)
  const [protein, setProtein] = useState(goal?.protein || 0)
  const save = async () => {
    try { await api('/api/meals/goal', { method: 'PUT', body: JSON.stringify({ kcal, protein }) }); close(); onSaved() }
    catch (e) { toast(problem(e)) }
  }
  return <>
    <h3>{t('Daily targets')}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{t('Leave both at 0 to track without targets.')}</div>
    <label className="small muted">{t('Calories (kcal)')}<NumberField decimal={false} value={kcal} onChange={setKcal} /></label>
    <div style={{ height: 10 }} />
    <label className="small muted">{t('Protein (g)')}<NumberField decimal={false} value={protein} onChange={setProtein} /></label>
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={save}>{t('Save')}</Button>
  </>
}

/* ---------------------------------------------------------------- the screen */

function Bar({ value, target, color }) {
  const p = target > 0 ? Math.min(100, (value / target) * 100) : 0
  return <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-3)', overflow: 'hidden', marginTop: 6 }}>
    <div style={{ width: p + '%', height: '100%', background: value > target ? 'var(--orange)' : color }} />
  </div>
}

function Week({ week, goal, bodyweight, unit }) {
  const avg = weekAverage(week)
  const top = Math.max(goal?.kcal || 0, ...week.map(d => d.kcal), 1)
  const bw = weightChange(bodyweight, week[0].day, week[week.length - 1].day)
  return <div className="card">
    <div className="row between"><b>{t('Last 7 days')}</b>{avg && <span className="small muted">{t('Average {0}', kcalText(avg.kcal))}</span>}</div>
    <div className="row" style={{ alignItems: 'flex-end', gap: 6, height: 90, marginTop: 10 }}>
      {week.map(d => <div key={d.day} style={{ flex: 1, textAlign: 'center' }}>
        <div title={kcalText(d.kcal)} style={{ height: Math.max(2, (d.kcal / top) * 70), borderRadius: 4, background: d.meals ? 'var(--acc)' : 'var(--surface-3)' }} />
        <div className="small dim" style={{ marginTop: 4 }}>{t(DAYS[new Date(d.day + 'T12:00:00').getDay()])}</div>
      </div>)}
    </div>
    {avg && <div className="small muted" style={{ marginTop: 8 }}>
      {t('{0} of 7 days logged · {1} g protein a day', avg.days, avg.protein)}
    </div>}
    {bw && <div className="small muted" style={{ marginTop: 4 }}>
      {t('Weight over these days: {0}', (bw.change > 0 ? '+' : '') + fmtNum(bw.change) + ' ' + unit)}
    </div>}
  </div>
}

export default function Meals() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const [day, setDay] = useState(todayISO())
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(null)
  const [reading, setReading] = useState(false)
  const cam = useRef(null)
  const lib = useRef(null)
  const today = todayISO()

  const load = useCallback(() => {
    setFailed(null)
    return api('/api/meals?day=' + day).then(setData).catch(e => setFailed(problem(e)))
  }, [day])
  useEffect(() => { setData(null); load() }, [load])

  const onPhoto = async e => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setReading(true)
    try {
      const image = await mealPhotoDataUrl(file)
      const r = await api('/api/meals/estimate', { method: 'POST', body: JSON.stringify({ image }), timeout: 90000 })
      if (!r.items.length) { toast(t('No food found in that photo. Try again, or add it by hand.')); return }
      const at = day === today ? Date.now() : new Date(day + 'T12:00:00').getTime()
      mealSheet({ day, at, slot: slotFor(new Date(at)), items: r.items, source: 'photo', note: r.note || '' }, load, r.note)
      load()
    } catch (err) { toast(problem(err)) } finally { setReading(false) }
  }
  const addByHand = () => {
    const at = day === today ? Date.now() : new Date(day + 'T12:00:00').getTime()
    mealSheet({ day, at, slot: slotFor(new Date(at)), items: [], source: 'manual' }, load)
  }

  const meals = data?.meals || []
  const total = mealTotals(meals.flatMap(m => m.items))
  const goal = data?.goal || null
  const kp = progress(total.kcal, goal?.kcal), pp = progress(total.protein, goal?.protein)
  const ordered = SLOTS.flatMap(s => meals.filter(m => m.slot === s.id))

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" data-back="/home" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('Meals')}</h1><div className="sub">{day === today ? t('Today') : fmtDate(day, true)}</div></div>
      <button className="iconbtn" onClick={() => setDay(d => addDays(d, -1))} aria-label={t('Previous day')}><Icon name="chevronLeft" /></button>
      <button className="iconbtn" disabled={day >= today} onClick={() => setDay(d => addDays(d, 1))} aria-label={t('Next day')}><Icon name="chevronRight" /></button>
    </div>

    <div className="card">
      <div className="row between">
        <div>
          <div className="muted small">{t('Calories')}</div>
          <div className="big">{total.kcal.toLocaleString()} <span className="muted" style={{ fontSize: 'var(--fs-callout)' }}>{goal?.kcal ? '/ ' + kcalText(goal.kcal) : t('kcal')}</span></div>
        </div>
        <Button size="sm" variant="ghost" icon="target" onClick={() => ui().openSheet(close => <GoalSheet goal={goal} onSaved={load} close={close} />)}>{t('Targets')}</Button>
      </div>
      {kp && <><Bar value={total.kcal} target={goal.kcal} color="var(--acc)" />
        <div className="small muted" style={{ marginTop: 4 }}>{kp.left >= 0 ? t('{0} left', kcalText(kp.left)) : t('{0} over', kcalText(-kp.left))}</div></>}
      <div className="small" style={{ marginTop: 10 }}>
        <b>{t('Protein {0}', gramsText(total.protein))}</b>{goal?.protein ? <span className="muted"> / {gramsText(goal.protein)}</span> : null}
        <span className="muted"> · {t('Carbs {0}', gramsText(total.carbs))} · {t('Fat {0}', gramsText(total.fat))}</span>
      </div>
      {pp && <Bar value={total.protein} target={goal.protein} color="var(--teal)" />}
    </div>

    <div className="card">
      <Button variant="primary" icon="camera" disabled={reading} onClick={() => cam.current?.click()}>{reading ? t('Reading your meal…') : t('Take a photo of a meal')}</Button>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <Button icon="image" disabled={reading} onClick={() => lib.current?.click()} style={{ flex: 1 }}>{t('Choose a photo')}</Button>
        <Button icon="pencil" disabled={reading} onClick={addByHand} style={{ flex: 1 }}>{t('Add by hand')}</Button>
      </div>
      {data?.ai && <div className="small dim" style={{ marginTop: 8 }}>{t('Photos read today: {0} of {1}', data.ai.used, data.ai.limit)}</div>}
      <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
      <input ref={lib} type="file" accept="image/*" hidden onChange={onPhoto} />
    </div>

    {failed && <div className="card"><div className="small" role="alert">{failed}</div><div style={{ height: 8 }} /><Button size="sm" onClick={load}>{t('Try again')}</Button></div>}

    <h4 className="sec" style={{ margin: '18px 2px 10px' }}>{day === today ? t('Today’s meals') : t('Meals that day')}</h4>
    {ordered.length ? <div className="list">{ordered.map(m => {
      const mt = mealTotals(m.items)
      return <div key={m.id} className="card tap-host" role="button" tabIndex={0} onClick={() => mealSheet(m, load)}
        onKeyDown={e => { if (e.key === 'Enter') mealSheet(m, load) }}>
        <div className="row between">
          <b>{t(SLOT_LABEL[m.slot] || 'Snack')}</b>
          <span className="small muted">{kcalText(mt.kcal)} · {timeOf(m.at)}</span>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>{m.items.map(i => i.name).join(', ')}</div>
        <div className="small dim" style={{ marginTop: 2 }}>{t('Protein {0} g · Carbs {1} g · Fat {2} g', mt.protein, mt.carbs, mt.fat)}</div>
      </div>
    })}</div> : data && <div className="empty small">{t('No meals logged yet.')}</div>}

    {data?.week && <Week week={data.week} goal={goal} bodyweight={S.bodyweight} unit={S.unit} />}
  </div>
}
