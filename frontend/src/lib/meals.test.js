import { describe, it, expect } from 'vitest'
import { slotFor, scaleItem, mealTotals, addDays, weekAverage, progress, weightChange, savableItems } from './meals.js'

const at = h => new Date(2026, 10, 12, h, 30)

describe('meals', () => {
  it('guesses the part of the day from the time', () => {
    expect(slotFor(at(7))).toBe('breakfast')
    expect(slotFor(at(13))).toBe('lunch')
    expect(slotFor(at(17))).toBe('snack')
    expect(slotFor(at(20))).toBe('dinner')
    expect(slotFor(at(1))).toBe('snack')
  })

  it('scales a food with its grams, and leaves one without grams alone', () => {
    const chapati = { name: 'Chapati', grams: 40, kcal: 120, protein: 3.5, carbs: 20, fat: 3 }
    expect(scaleItem(chapati, 80)).toEqual({ name: 'Chapati', grams: 80, kcal: 240, protein: 7, carbs: 40, fat: 6 })
    expect(scaleItem(chapati, 0).kcal).toBe(0)
    expect(scaleItem({ name: 'Tea', grams: 0, kcal: 40 }, 150)).toEqual({ name: 'Tea', grams: 150, kcal: 40 })
  })

  it('adds a meal up', () => {
    expect(mealTotals([{ kcal: 120.4, protein: 3.5, carbs: 20, fat: 3 }, { kcal: 260, protein: 12, carbs: 30.6, fat: -1 }]))
      .toEqual({ kcal: 380, protein: 16, carbs: 51, fat: 3 })
    expect(mealTotals(null)).toEqual({ kcal: 0, protein: 0, carbs: 0, fat: 0 })
  })

  it('moves by calendar days across months and years', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('averages only the days that have meals', () => {
    const week = [{ meals: 0, kcal: 0, protein: 0 }, { meals: 3, kcal: 2000, protein: 120 }, { meals: 2, kcal: 1800, protein: 100 }]
    expect(weekAverage(week)).toEqual({ kcal: 1900, protein: 110, days: 2 })
    expect(weekAverage([{ meals: 0, kcal: 0, protein: 0 }])).toBe(null)
  })

  it('says how far into a target, and nothing without one', () => {
    expect(progress(1650, 2200)).toEqual({ pct: 75, left: 550 })
    expect(progress(2400, 2200)).toEqual({ pct: 109, left: -200 })
    expect(progress(500, 0)).toBe(null)
  })

  it('reads the weight change across a range from the first to the last weigh-in', () => {
    const bw = [{ d: '2026-11-01', w: 80 }, { d: '2026-11-09', w: 79.6 }, { d: '2026-11-06', w: 80.4 }, { d: '2026-11-12', w: 79.2 }]
    expect(weightChange(bw, '2026-11-06', '2026-11-12')).toEqual({ from: 80.4, to: 79.2, change: -1.2, days: 6 })
    expect(weightChange(bw, '2026-11-10', '2026-11-12')).toBe(null)
  })

  it('keeps only named lines, with clean numbers', () => {
    expect(savableItems([{ name: ' Dal ', grams: 200, kcal: 260, protein: 12, carbs: 30, fat: NaN }, { name: '  ', kcal: 50 }, null]))
      .toEqual([{ name: 'Dal', grams: 200, kcal: 260, protein: 12, carbs: 30, fat: 0 }])
  })
})
