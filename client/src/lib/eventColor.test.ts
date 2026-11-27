import { describe, expect, it } from 'vitest';
import { DEFAULT_EVENT_COLOR, memberColor, resolveEventColor } from './eventColor';

const members = [
    { id: 'axel', color: '#3B82F6' },
    { id: 'debo', color: '#EC4899' },
    { id: 'noir', color: '' },
];

describe('memberColor', () => {
    it('returns the color of the first assigned member that has one', () => {
        expect(memberColor(['debo', 'axel'], members)).toBe('#EC4899');
        expect(memberColor(['axel'], members)).toBe('#3B82F6');
    });
    it('skips members without a color and falls back to the default', () => {
        expect(memberColor(['noir'], members)).toBe(DEFAULT_EVENT_COLOR);
        expect(memberColor([], members)).toBe(DEFAULT_EVENT_COLOR);
        expect(memberColor(['inconnu'], members)).toBe(DEFAULT_EVENT_COLOR);
        expect(memberColor(['noir'], members, '#111111')).toBe('#111111');
    });
});

describe('resolveEventColor (B2 — la couleur suit l\'assigné jusqu\'au choix manuel)', () => {
    it('untouched: follows the assignee, and follows assignee changes', () => {
        expect(resolveEventColor({ color: DEFAULT_EVENT_COLOR, colorTouched: false, memberIds: ['axel'], members })).toBe('#3B82F6');
        expect(resolveEventColor({ color: DEFAULT_EVENT_COLOR, colorTouched: false, memberIds: ['debo'], members })).toBe('#EC4899');
        expect(resolveEventColor({ color: DEFAULT_EVENT_COLOR, colorTouched: false, memberIds: [], members })).toBe(DEFAULT_EVENT_COLOR);
    });
    it('touched: the manual pick wins over the assignee', () => {
        expect(resolveEventColor({ color: '#22C55E', colorTouched: true, memberIds: ['axel'], members })).toBe('#22C55E');
    });
});
