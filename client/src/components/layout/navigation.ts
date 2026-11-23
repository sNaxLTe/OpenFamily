import {
    Home,
    ShoppingCart,
    CheckSquare,
    Calendar as CalendarIcon,
    CalendarDays,
    ChefHat,
    UtensilsCrossed,
    Wallet,
    Users,
    Settings,
    Plug,
    PiggyBank,
    MessageSquare,
    LayoutGrid,
    Refrigerator,
    MonitorPlay,
    ListChecks,
} from 'lucide-react';

export interface NavItem {
    labelKey: string;
    href: string;
    icon: typeof Home;
    /** An optional module the family can switch off (see TOGGLEABLE_MODULES on the server). */
    module?: string;
    /** Shorter label for the bottom bar, where a slot is narrow. */
    tabLabelKey?: string;
}

// Every section of the app, in a stable order. Entries without a `module`
// are always on and can never be hidden.
export const NAVIGATION: NavItem[] = [
    { labelKey: 'items.today', href: '/', icon: Home, tabLabelKey: 'mobile.home' },
    { labelKey: 'items.shopping', href: '/shopping', icon: ShoppingCart, tabLabelKey: 'mobile.shopping' },
    { labelKey: 'items.tasks', href: '/tasks', icon: CheckSquare, tabLabelKey: 'mobile.tasks' },
    { labelKey: 'items.lists', href: '/lists', icon: ListChecks, module: 'lists', tabLabelKey: 'mobile.lists' },
    { labelKey: 'items.posts', href: '/posts', icon: MessageSquare },
    { labelKey: 'items.rewards', href: '/rewards', icon: PiggyBank, module: 'rewards' },
    { labelKey: 'items.calendar', href: '/calendar', icon: CalendarIcon, tabLabelKey: 'mobile.calendar' },
    { labelKey: 'items.planning', href: '/planning', icon: CalendarDays, module: 'planning' },
    { labelKey: 'items.recipes', href: '/recipes', icon: ChefHat, module: 'recipes' },
    { labelKey: 'items.meals', href: '/meal-planning', icon: UtensilsCrossed, module: 'meals' },
    { labelKey: 'items.pantry', href: '/pantry', icon: Refrigerator, module: 'pantry' },
    { labelKey: 'items.budget', href: '/budget', icon: Wallet, module: 'budget' },
    { labelKey: 'items.family', href: '/family', icon: Users },
    { labelKey: 'items.integrations', href: '/integrations', icon: Plug, module: 'integrations' },
    { labelKey: 'items.settings', href: '/settings', icon: Settings },
];

// The wall display leaves the app's frame, but it is a section all the same:
// it sits in "More" and can join the bottom bar like any other.
export const KIOSK_ITEM: NavItem = { labelKey: 'kiosk:settings.title', href: '/kiosk', icon: MonitorPlay, module: 'kiosk' };

export const MORE_TAB: NavItem = { labelKey: 'mobile.more', href: '/more', icon: LayoutGrid };

export const isRouteActive = (pathname: string, href: string): boolean => {
    if (href === '/') {
        return pathname === '/';
    }
    return pathname === href || pathname.startsWith(`${href}/`);
};

// ---------------------------------------------------------------------------
// The bottom bar (feature 12): the sections shown as tabs at the bottom of
// every screen, chosen per device in "More" and kept in localStorage. "More"
// is always the last slot and can never be removed.
// ---------------------------------------------------------------------------

/** The default bar: home, calendar, tasks, shopping, budget — then "More". */
export const DEFAULT_BOTTOM_BAR_HREFS: readonly string[] = ['/', '/calendar', '/tasks', '/shopping', '/budget'];

export const BOTTOM_BAR_STORAGE_KEY = 'openfamily.bottomBar';
export const BOTTOM_BAR_CHANGED_EVENT = 'openfamily:bottom-bar-changed';

/** On a narrow screen the bar holds 4 to 8 slots, "More" included. */
export const BOTTOM_BAR_MIN_SLOTS = 4;
export const BOTTOM_BAR_MAX_SLOTS = 8;
/** Up to this width the screen counts as narrow (about a phone in portrait). */
export const NARROW_SCREEN_MAX_WIDTH = 480;

const narrowScreenQuery = () => `(max-width: ${NARROW_SCREEN_MAX_WIDTH - 1}px)`;

export const isNarrowScreen = (): boolean =>
    typeof window !== 'undefined' && window.matchMedia(narrowScreenQuery()).matches;

/** Every section the bar can hold: all sections of "More". */
export const bottomBarPool = (isModuleEnabled: (module: string) => boolean): NavItem[] =>
    [...NAVIGATION, KIOSK_ITEM].filter((item) => !item.module || isModuleEnabled(item.module));

/** The stored selection, validated against the pool and put in pool order. */
export const loadBottomBarHrefs = (pool: NavItem[]): string[] => {
    const poolHrefs = new Set(pool.map((item) => item.href));
    let stored: unknown = null;
    try {
        stored = JSON.parse(localStorage.getItem(BOTTOM_BAR_STORAGE_KEY) ?? 'null');
    } catch {
        stored = null;
    }
    const kept = Array.isArray(stored)
        ? Array.from(new Set(stored.filter((h): h is string => typeof h === 'string' && poolHrefs.has(h))))
        : [];
    const base = kept.length > 0 ? kept : DEFAULT_BOTTOM_BAR_HREFS.filter((h) => poolHrefs.has(h));
    // The bar follows the pool's order, so a section toggled back on lands
    // where it belongs, not at the end.
    return pool.filter((item) => base.includes(item.href)).map((item) => item.href);
};

export const saveBottomBarHrefs = (hrefs: readonly string[]): void => {
    try {
        localStorage.setItem(BOTTOM_BAR_STORAGE_KEY, JSON.stringify(hrefs));
        // The bar lives in the layout, one level up: let it know.
        window.dispatchEvent(new CustomEvent(BOTTOM_BAR_CHANGED_EVENT));
    } catch {
        // Storage refused (private window): the choice lasts for this visit.
    }
};

/**
 * What the bar shows at the current width: on a narrow screen 4 to 8 slots
 * ("More" included), on a wide one every chosen slot, with no maximum.
 */
export const clampBarHrefsForWidth = (hrefs: readonly string[], pool: NavItem[], narrow: boolean): string[] => {
    const ordered = pool.filter((item) => hrefs.includes(item.href)).map((item) => item.href);
    if (!narrow) return ordered;
    const maxSelected = BOTTOM_BAR_MAX_SLOTS - 1; // "More" always takes the last slot
    const minSelected = BOTTOM_BAR_MIN_SLOTS - 1;
    let result = ordered.slice(0, maxSelected);
    if (result.length < minSelected) {
        for (const item of pool) {
            if (result.length >= minSelected) break;
            if (!result.includes(item.href)) result.push(item.href);
        }
    }
    return result;
};

/** True when the page shown has a tab of its own in the bottom bar. */
export const isOnBarTab = (pathname: string, hrefs: readonly string[]): boolean =>
    hrefs.some((href) => isRouteActive(pathname, href));
