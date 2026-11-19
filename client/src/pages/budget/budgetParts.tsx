import React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCategories } from '../../hooks/useCategories';

// Form building blocks shared by the Budget page and its annual view, so both
// render exactly the same sheets, fields and category pickers.

export const Sheet: React.FC<{ open: boolean; onClose: () => void; title: string; children: React.ReactNode }> = ({
    open, onClose, title, children
}) => {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" onClick={onClose}>
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
            <div
                className="relative bg-background rounded-t-2xl shadow-2xl max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-lg font-semibold">{title}</h2>
                    <button onClick={onClose} className="p-2 rounded-full hover:bg-surface-2 transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <div className="p-4">{children}</div>
            </div>
        </div>
    );
};

export const Field: React.FC<{
    label: string;
    type?: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    required?: boolean;
    min?: string;
    max?: string;
    step?: string;
}> = ({ label, type = 'text', value, onChange, placeholder, required, min, max, step }) => (
    <div>
        <label className="block text-sm font-medium text-foreground mb-1">{label}</label>
        <input
            type={type}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            required={required}
            min={min}
            max={max}
            step={step}
            className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface-1 text-foreground text-base
                       focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
        />
    </div>
);

export const CategorySelect: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
    const { t } = useTranslation('budget');
    // Family-customizable list (Settings → Categories). If the current value is no
    // longer in the list (legacy row, renamed category), keep it selectable so the
    // form doesn't silently change the entry's category.
    const { categories: familyCategories } = useCategories();
    const list = !value || familyCategories.budget.includes(value)
        ? familyCategories.budget
        : [value, ...familyCategories.budget];
    return (
        <div>
            <label className="block text-sm font-medium text-foreground mb-1">{t('budget:fields.category')}</label>
            <select
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-border bg-surface-1 text-foreground text-base
                           focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition"
            >
                {list.map((c) => <option key={c} value={c}>{t(`budget:categories.${c}`, { defaultValue: c })}</option>)}
            </select>
        </div>
    );
};
