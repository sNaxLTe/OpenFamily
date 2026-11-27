// Pure helpers for the Budget hero (E2) and the quick-entry sheet (E3).

export interface ForecastLike {
    openingBalance: number;
    currentBalance: number;
    forecastBalance: number;
    upcomingRecurringIncome: number;
    upcomingRecurringExpenses: number;
}

export interface HeroData {
    balance: number;
    balancePositive: boolean;
    opening: number;
    /** null when there is no upcoming recurring movement to forecast. */
    forecast: number | null;
    forecastPositive: boolean;
    upcomingIncome: number;
    upcomingExpenses: number;
}

/**
 * Merges the balance card and the forecast card into ONE hero (E2): the
 * forecast line only exists when a recurring movement is still upcoming.
 */
export const buildHero = (forecast: ForecastLike | null): HeroData => {
    const balance = forecast?.currentBalance ?? 0;
    const upcomingIncome = forecast?.upcomingRecurringIncome ?? 0;
    const upcomingExpenses = forecast?.upcomingRecurringExpenses ?? 0;
    const hasForecast = upcomingIncome > 0 || upcomingExpenses > 0;
    return {
        balance,
        balancePositive: balance >= 0,
        opening: forecast?.openingBalance ?? 0,
        forecast: hasForecast ? (forecast?.forecastBalance ?? 0) : null,
        forecastPositive: (forecast?.forecastBalance ?? 0) >= 0,
        upcomingIncome,
        upcomingExpenses,
    };
};

/**
 * Most frequent EXPENSE category of the user's history (entries are expected
 * date-DESC, so on a tie the most recent category wins). Falls back when the
 * history has no expense yet. Used as the default category of the quick-entry
 * sheet (E3) — the user can always change it.
 */
export const mostFrequentCategory = (
    entries: readonly { category: string; is_expense?: boolean }[],
    fallback: string,
): string => {
    const counts = new Map<string, number>();
    for (const e of entries) {
        if (e.is_expense === false || !e.category) continue;
        counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [category, count] of counts) {
        if (count > bestCount) {
            best = category;
            bestCount = count;
        }
    }
    return best ?? fallback;
};

export interface AnnualLike {
    balance: number;
    previousYear: { totalIncome: number; totalExpenses: number; balance: number };
}

/**
 * "vs N-1" hero of the annual view (E2): the delta is only meaningful when the
 * previous year actually has data.
 */
export const yearDelta = (annual: AnnualLike | null): { hasPreviousYear: boolean; delta: number } => {
    if (!annual) return { hasPreviousYear: false, delta: 0 };
    const prev = annual.previousYear;
    const hasPreviousYear = prev.totalIncome !== 0 || prev.totalExpenses !== 0;
    return { hasPreviousYear, delta: annual.balance - prev.balance };
};
