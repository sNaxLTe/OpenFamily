import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useHistoryAwareOverlay } from '../../lib/useHistoryAwareOverlay';

interface DialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    children: React.ReactNode;
    className?: string;
    /**
     * Default true: tap outside the dialog and back/swipe-back close it.
     * Set false on EDITING dialogs (unsaved input): outside taps are ignored
     * and back/swipe-back is consumed silently — only the X button or an
     * explicit action button closes. Escape stays active (voluntary key).
     */
    dismissible?: boolean;
}

export const Dialog: React.FC<DialogProps> = ({
    open,
    onOpenChange,
    title,
    description,
    children,
    className,
    dismissible = true,
}) => {
    // History-aware on every Dialog: back/swipe-back closes the dialog instead
    // of leaving the app (standalone PWA). With dismissible={false} the pop is
    // consumed silently instead (see useHistoryAwareOverlay).
    useHistoryAwareOverlay(open, () => onOpenChange(false), { closeOnPop: dismissible });

    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm animate-fade-in" />
                <DialogPrimitive.Content
                    onInteractOutside={dismissible ? undefined : (e) => e.preventDefault()}
                    onPointerDownOutside={dismissible ? undefined : (e) => e.preventDefault()}
                    onFocusOutside={dismissible ? undefined : (e) => e.preventDefault()}
                    className={cn(
                        'fixed inset-x-0 bottom-0 z-50 w-full border border-border bg-card shadow-surface-hover animate-slide-up',
                        'max-h-[90vh] overflow-y-auto rounded-t-[20px] p-0',
                        'sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card',
                        className
                    )}
                >
                    <div className="flex items-start justify-between border-b border-border px-5 py-4 md:px-6">
                        <div className="pr-4">
                            <DialogPrimitive.Title className="text-h2 font-semibold">
                                {title}
                            </DialogPrimitive.Title>
                            {description && (
                                <DialogPrimitive.Description className="mt-1 text-caption text-muted-foreground">
                                    {description}
                                </DialogPrimitive.Description>
                            )}
                        </div>
                        <DialogPrimitive.Close className="rounded-input p-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground">
                            <X className="h-5 w-5" />
                            <span className="sr-only">Fermer</span>
                        </DialogPrimitive.Close>
                    </div>
                    <div className="px-5 py-4 md:px-6 md:py-5">{children}</div>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
};
