import React from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3 } from 'lucide-react';

// Local guard around a chart: a rendering error inside a chart (recharts keeps
// internal state between renders) must never unmount the whole page. The
// boundary shows a small fallback with a retry that remounts the chart fresh.

interface Props {
    children: React.ReactNode;
}

interface State {
    error: Error | null;
}

const Fallback: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
    const { t } = useTranslation(['common']);
    return (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <BarChart3 className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('common:states.chartError')}</p>
            <button
                type="button"
                onClick={onRetry}
                className="rounded-input border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-2"
            >
                {t('common:actions.retry')}
            </button>
        </div>
    );
};

class ChartErrorBoundary extends React.Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error) {
        // The page stays alive; the error is contained to the chart area.
        console.error('chart render error', error);
    }

    private retry = () => {
        this.setState({ error: null });
    };

    render() {
        if (this.state.error) {
            // The children are unmounted while the fallback shows, so the
            // retry remounts the chart fresh — no stale internal state survives.
            return <Fallback onRetry={this.retry} />;
        }
        return this.props.children;
    }
}

export default ChartErrorBoundary;
