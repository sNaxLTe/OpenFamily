import React, { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { useTheme } from '../../contexts/ThemeContext';
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
    Moon,
    Sun,
    LogOut,
    Plus,
    WifiOff,
    MessageSquare,
    MonitorPlay,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useHistoryAwareOverlay } from '../../lib/useHistoryAwareOverlay';
import { Button } from '../ui/Button';
import { NotificationBell } from '../ui/NotificationBell';
import { DemoBanner } from '../app/DemoBanner';
import { MagicInputButton } from '../app/MagicInput';
import WelcomeSetup from '../app/WelcomeSetup';
import {
    NAVIGATION,
    MORE_TAB,
    isRouteActive,
    isOnBarTab,
    bottomBarPool,
    loadBottomBarHrefs,
    clampBarHrefsForWidth,
    isNarrowScreen,
    BOTTOM_BAR_CHANGED_EVENT,
    NARROW_SCREEN_MAX_WIDTH,
} from './navigation';

interface LayoutProps {
    children: ReactNode;
}

const quickActions: { labelKey: string; href: string; icon: typeof Home; module?: string }[] = [
    { labelKey: 'quickActions.addShopping', href: '/shopping', icon: ShoppingCart },
    { labelKey: 'quickActions.addTask', href: '/tasks?new=1', icon: CheckSquare },
    { labelKey: 'quickActions.addPost', href: '/posts', icon: MessageSquare },
    { labelKey: 'quickActions.addAppointment', href: '/calendar?new=1', icon: CalendarIcon },
    { labelKey: 'quickActions.addSchedule', href: '/planning', icon: CalendarDays, module: 'planning' },
    { labelKey: 'quickActions.addRecipe', href: '/recipes', icon: ChefHat, module: 'recipes' },
    { labelKey: 'quickActions.addMeal', href: '/meal-planning', icon: UtensilsCrossed, module: 'meals' },
    { labelKey: 'quickActions.addExpense', href: '/budget?new=1', icon: Wallet, module: 'budget' },
    { labelKey: 'quickActions.addMember', href: '/family', icon: Users },
];

// One bar at the bottom of every screen (feature 12): the sections the person
// chose on this device, then "More". No menu down the side, no hamburger —
// everything else is one tap away in "More". The header above stays slim:
// the page's title and its actions.
const Layout: React.FC<LayoutProps> = ({ children }) => {
    const location = useLocation();
    const { t } = useTranslation('nav');
    const { logout, isModuleEnabled } = useAuth();
    const { setTheme, actualTheme } = useTheme();

    const visibleQuickActions = quickActions.filter((item) => !item.module || isModuleEnabled(item.module));
    const [quickActionsOpen, setQuickActionsOpen] = React.useState(false);
    // B1: quick-actions overlay is protected — back/swipe-back consumed
    // silently, backdrop tap no longer closes; the "+" button or Escape does.
    useHistoryAwareOverlay(quickActionsOpen, () => setQuickActionsOpen(false), { closeOnPop: false });
    React.useEffect(() => {
        if (!quickActionsOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setQuickActionsOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [quickActionsOpen]);
    const [isOffline, setIsOffline] = React.useState(!navigator.onLine);

    // The bottom bar's slots, kept per device in localStorage (key
    // openfamily.bottomBar). Empty storage means the default six slots.
    const pool = bottomBarPool(isModuleEnabled);
    const poolKey = pool.map((item) => item.href).join(',');
    const [barHrefs, setBarHrefs] = React.useState<string[]>(() => loadBottomBarHrefs(pool));
    React.useEffect(() => {
        const refresh = () => setBarHrefs(loadBottomBarHrefs(bottomBarPool(isModuleEnabled)));
        refresh();
        window.addEventListener(BOTTOM_BAR_CHANGED_EVENT, refresh);
        window.addEventListener('storage', refresh);
        return () => {
            window.removeEventListener(BOTTOM_BAR_CHANGED_EVENT, refresh);
            window.removeEventListener('storage', refresh);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [poolKey]);

    // Below ~480px the screen counts as narrow: the bar keeps 4 to 8 slots and
    // drops the labels past six slots to stay readable.
    const [narrow, setNarrow] = React.useState(isNarrowScreen);
    React.useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${NARROW_SCREEN_MAX_WIDTH - 1}px)`);
        const onChange = () => setNarrow(mq.matches);
        onChange();
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    }, []);

    React.useEffect(() => {
        const goOnline = () => setIsOffline(false);
        const goOffline = () => setIsOffline(true);
        window.addEventListener('online', goOnline);
        window.addEventListener('offline', goOffline);
        return () => {
            window.removeEventListener('online', goOnline);
            window.removeEventListener('offline', goOffline);
        };
    }, []);

    const currentPage = NAVIGATION.find((item) => isRouteActive(location.pathname, item.href));
    const pageTitle = currentPage
        ? t(currentPage.labelKey)
        : location.pathname === MORE_TAB.href ? t(MORE_TAB.labelKey) : t('pageTitleFallback');

    const toggleTheme = () => {
        setTheme(actualTheme === 'dark' ? 'light' : 'dark');
    };

    const visibleHrefs = clampBarHrefsForWidth(barHrefs, pool, narrow);
    const barItems = [
        ...visibleHrefs.map((href) => pool.find((item) => item.href === href) ?? MORE_TAB),
        MORE_TAB,
    ];
    const onBarTab = isOnBarTab(location.pathname, visibleHrefs);
    const onMoreGrid = location.pathname === MORE_TAB.href;
    // Past six slots on a narrow screen, icons only: the labels would not fit.
    const iconsOnly = narrow && barItems.length > 6;

    return (
        <div className="min-h-screen bg-background font-sans text-foreground">
            {quickActionsOpen && (
                <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
            )}

            <div>
                <DemoBanner />
                {/* Slim header on every width: the page's title, its actions. */}
                <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur-md">
                    {/* The page takes the width of the screen up to a limit past
                        which lines get too long to read: nothing is gained by
                        leaving half of a wide screen empty. */}
                    <div className="mx-auto flex h-16 w-full max-w-[1760px] items-center justify-between px-4 lg:px-8 2xl:px-10">
                        <h1 className="text-caption font-semibold text-foreground">
                            {pageTitle}
                        </h1>

                        <div className="flex items-center gap-2">
                            <MagicInputButton />
                            {/* One tap to the wall display, from any page */}
                            {isModuleEnabled('kiosk') && (
                                <Link
                                    to="/kiosk"
                                    aria-label={t('kiosk:settings.open')}
                                    title={t('kiosk:settings.open')}
                                    className="btn-nexus btn-secondary flex h-10 w-10 shrink-0 items-center justify-center"
                                >
                                    <MonitorPlay className="h-4 w-4" />
                                </Link>
                            )}
                            <NotificationBell />
                            {/* Theme and sign-out live in "More" on a phone; the header carries them on a wide screen. */}
                            <div className="hidden items-center gap-2 lg:flex">
                                <Button
                                    variant="secondary"
                                    size="icon"
                                    onClick={toggleTheme}
                                    aria-label={t('user.toggleTheme')}
                                >
                                    {actualTheme === 'dark' ? (
                                        <Sun className="h-4 w-4" />
                                    ) : (
                                        <Moon className="h-4 w-4" />
                                    )}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={logout}
                                    aria-label={t('user.logout')}
                                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                >
                                    <LogOut className="h-4 w-4" />
                                </Button>
                            </div>
                        </div>
                    </div>
                </header>

                <main className="mx-auto w-full max-w-[1760px] px-4 pb-28 pt-6 lg:px-8 lg:pb-32 lg:pt-8 2xl:px-10">
                    {isOffline && (
                        <div role="status" aria-live="polite" className="mb-4 flex items-center gap-2 rounded-card border border-amber-300 bg-amber-50 px-4 py-2.5 text-caption text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400">
                            <WifiOff className="h-4 w-4 flex-shrink-0" />
                            {t('offline')}
                        </div>
                    )}
                    {children}
                </main>
            </div>

            {/* Nothing to add from the grid of sections: the button would only sit on its last row. */}
            {!onMoreGrid && (
                <button
                    type="button"
                    onClick={() => setQuickActionsOpen((open) => !open)}
                    className="fixed bottom-24 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-surface-hover transition-all duration-fast ease-soft hover:bg-primary-hover active:scale-[0.98] lg:bottom-28 lg:right-8"
                    aria-label={t('quickActions.title')}
                >
                    <Plus className="h-6 w-6" />
                </button>
            )}

            <div
                role="dialog"
                aria-modal="false"
                aria-label={t('quickActions.title')}
                className={cn(
                    'fixed inset-x-4 bottom-44 z-50 rounded-card border border-border bg-card p-4 shadow-surface-hover md:inset-x-auto md:bottom-44 md:right-8 md:w-80',
                    'transition-all duration-base ease-soft',
                    quickActionsOpen
                        ? 'pointer-events-auto translate-y-0 opacity-100'
                        : 'pointer-events-none translate-y-3 opacity-0'
                )}
            >
                {/* F2: titre centré, actions en grille 2 colonnes, icône grande
                    avec le libellé en petit dessous, cibles >= 44px */}
                <p className="mb-3 text-center text-caption font-semibold text-foreground">{t('quickActions.title')}</p>
                <div className="grid grid-cols-2 gap-2">
                    {visibleQuickActions.map((action) => {
                        const Icon = action.icon;
                        return (
                            <Link
                                key={action.labelKey}
                                to={action.href}
                                onClick={() => setQuickActionsOpen(false)}
                                className="flex min-h-11 flex-col items-center justify-center gap-1 rounded-input px-2 py-2 text-center text-foreground hover:bg-surface-2"
                            >
                                <Icon className="h-6 w-6 text-primary" />
                                <span className="text-[11px] leading-tight">{t(action.labelKey)}</span>
                            </Link>
                        );
                    })}
                </div>
            </div>

            {/* The bar across the bottom of every screen, wide or narrow. On a
                wide screen each slot takes an equal share of the width and all
                the chosen tabs fit, labels shown; on a narrow screen past six
                slots the labels go and the icons stay readable. */}
            <nav
                aria-label={t('bar.label')}
                className="fixed inset-x-0 bottom-0 z-40 bg-background/95 pb-safe backdrop-blur"
            >
                <div
                    className={cn(
                        'grid grid-cols-[repeat(var(--tabs),minmax(0,1fr))] gap-1 px-2 py-2',
                        'min-[480px]:gap-1.5 min-[480px]:px-4 lg:gap-2 lg:px-8 lg:py-2.5'
                    )}
                    style={{ '--tabs': barItems.length } as React.CSSProperties}
                >
                    {barItems.map((item) => {
                        const Icon = item.icon;
                        const label = t(item.tabLabelKey ?? item.labelKey);
                        // "More" is lit for every page reached through it.
                        const active = item.href === MORE_TAB.href ? !onBarTab : isRouteActive(location.pathname, item.href);
                        return (
                            <Link
                                key={item.href}
                                to={item.href}
                                aria-current={active ? 'page' : undefined}
                                title={label}
                                className={cn(
                                    'flex flex-col items-center justify-center gap-1 rounded-input px-1 py-2',
                                    'transition-colors duration-fast ease-soft',
                                    active
                                        ? 'bg-primary-soft text-primary'
                                        : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'
                                )}
                            >
                                <Icon className={cn('h-5 w-5 shrink-0', iconsOnly && 'h-6 w-6')} />
                                <span
                                    className={cn(
                                        'max-w-full truncate text-[10px] font-medium leading-none min-[480px]:text-[11px] lg:text-caption',
                                        iconsOnly && 'hidden'
                                    )}
                                >
                                    {label}
                                </span>
                            </Link>
                        );
                    })}
                </div>
            </nav>

            {/* Shown once, to whoever has just created a family. */}
            <WelcomeSetup />
        </div>
    );
};

export default Layout;
