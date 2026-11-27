/** Couleur par défaut d'un rendez-vous (champ `color` des appointments). */
export const DEFAULT_EVENT_COLOR = '#DC4A60';

export interface ColorableMember {
    id: string;
    color?: string | null;
}

/**
 * Couleur du premier membre assigné trouvé dans `members` (dans l'ordre de
 * `memberIds`), sinon `fallback`. Base de la "couleur qui suit l'assigné".
 */
export const memberColor = (
    memberIds: readonly string[],
    members: readonly ColorableMember[],
    fallback: string = DEFAULT_EVENT_COLOR
): string => {
    for (const id of memberIds) {
        const m = members.find((mm) => mm.id === id);
        if (m?.color) return m.color;
    }
    return fallback;
};

/**
 * Couleur effective d'un rdv (B2) : si l'utilisateur a choisi une couleur
 * manuellement (`colorTouched`), elle gagne ; sinon la couleur suit le
 * premier membre assigné, sinon le défaut.
 */
export const resolveEventColor = (args: {
    color: string;
    colorTouched: boolean;
    memberIds: readonly string[];
    members: readonly ColorableMember[];
    fallback?: string;
}): string =>
    args.colorTouched
        ? args.color
        : memberColor(args.memberIds, args.members, args.fallback ?? DEFAULT_EVENT_COLOR);
