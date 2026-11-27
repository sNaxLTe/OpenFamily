import { describe, expect, it } from 'vitest';
import { buildHero, mostFrequentCategory, yearDelta } from './budgetHero';

// Run from the repo root: npx vitest run client/src/lib/budgetHero.test.ts

describe('buildHero (E2)', () => {
    it('no forecast data: balance 0, no forecast line', () => {
        const h = buildHero(null);
        expect(h).toMatchObject({ balance: 0, balancePositive: true, opening: 0, forecast: null });
    });

    it('forecast shown only when a recurring movement is upcoming', () => {
        const h = buildHero({
            openingBalance: 100, currentBalance: 80, forecastBalance: 30,
            upcomingRecurringIncome: 0, upcomingRecurringExpenses: 50,
        });
        expect(h.forecast).toBe(30);
        expect(h.forecastPositive).toBe(true);
        const none = buildHero({
            openingBalance: 100, currentBalance: 80, forecastBalance: 80,
            upcomingRecurringIncome: 0, upcomingRecurringExpenses: 0,
        });
        expect(none.forecast).toBeNull();
    });

    it('negative balance flags red', () => {
        expect(buildHero({ openingBalance: 0, currentBalance: -12, forecastBalance: -20, upcomingRecurringIncome: 0, upcomingRecurringExpenses: 8 }).balancePositive).toBe(false);
    });
});

describe('mostFrequentCategory (E3)', () => {
    it('picks the most frequent expense category, tie -> most recent (date DESC input)', () => {
        const entries = [
            { category: 'Courses', is_expense: true },   // most recent
            { category: 'Loisirs', is_expense: true },
            { category: 'Courses', is_expense: true },
            { category: 'Loisirs', is_expense: true },
            { category: 'Courses', is_expense: true },
        ];
        expect(mostFrequentCategory(entries, 'Autre')).toBe('Courses');
        // tie 2-2: first seen in the DESC list wins
        expect(mostFrequentCategory(entries.slice(0, 4), 'Autre')).toBe('Courses');
    });

    it('ignores incomes and empty categories', () => {
        const entries = [
            { category: 'Salaire', is_expense: false },
            { category: '', is_expense: true },
            { category: 'Courses', is_expense: true },
        ];
        expect(mostFrequentCategory(entries, 'Autre')).toBe('Courses');
    });

    it('falls back when there is no expense history', () => {
        expect(mostFrequentCategory([], 'Alimentation')).toBe('Alimentation');
        expect(mostFrequentCategory([{ category: 'Salaire', is_expense: false }], 'Alimentation')).toBe('Alimentation');
    });
});

describe('yearDelta (E2 annual hero)', () => {
    it('hidden when previous year has no data', () => {
        expect(yearDelta({ balance: 500, previousYear: { totalIncome: 0, totalExpenses: 0, balance: 0 } }))
            .toEqual({ hasPreviousYear: false, delta: 500 });
        expect(yearDelta(null)).toEqual({ hasPreviousYear: false, delta: 0 });
    });

    it('delta = current balance - previous balance', () => {
        expect(yearDelta({ balance: 700, previousYear: { totalIncome: 3000, totalExpenses: 2600, balance: 400 } }))
            .toEqual({ hasPreviousYear: true, delta: 300 });
    });
});
