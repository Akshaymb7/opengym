// Home's glance at today's food: calories and protein so far against the targets, one tap from
// the Meals screen (views/Meals.jsx). Shown only where the server has Meals (/api/config `meals`).
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { todayISO } from '../lib/format.js'
import { mealTotals } from '../lib/meals.js'
import CardHead from './CardHead.jsx'
import Icon from './Icon.jsx'

export const mealsAvailable = s => !!(s.user && s.config && s.config.meals)

export function MealsCard() {
  const nav = useNavigate()
  const on = useStore(mealsAvailable)
  const [today, setToday] = useState(null)
  useEffect(() => {
    if (!on) return undefined
    let live = true
    api('/api/meals?day=' + todayISO()).then(r => { if (live) setToday(r) }).catch(() => {})
    return () => { live = false }
  }, [on])
  if (!on) return null
  const total = mealTotals((today?.meals || []).flatMap(m => m.items))
  const goal = today?.goal
  const sub = !today ? t('Snap a photo of what you eat.')
    : !today.meals.length ? t('Nothing logged today. Snap a photo of what you eat.')
    : (goal?.kcal ? t('{0} of {1} kcal', total.kcal.toLocaleString(), goal.kcal.toLocaleString()) : t('{0} kcal', total.kcal.toLocaleString()))
      + ' · ' + (goal?.protein ? t('{0} of {1} g protein', total.protein, goal.protein) : t('{0} g protein', total.protein))
  return <div className="card tap-host">
    <CardHead icon="fork" tint="var(--green)" title={t('Meals')} sub={sub} open={{ onClick: () => nav('/meals') }}
      action={<Icon name="chevronRight" className="chev" />} />
  </div>
}
