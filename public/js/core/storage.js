const STRENGTH_FAVORITES_KEY = 'strengthFavoriteExerciseIds';

export function getStrengthFavoriteIds() {
  try {
    const raw = localStorage.getItem(STRENGTH_FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch (err) {
    return [];
  }
}

export function setStrengthFavoriteIds(ids) {
  localStorage.setItem(STRENGTH_FAVORITES_KEY, JSON.stringify([...new Set(ids)]));
}

export function toggleStrengthFavorite(id) {
  const current = new Set(getStrengthFavoriteIds());
  if (current.has(id)) current.delete(id);
  else current.add(id);
  setStrengthFavoriteIds([...current]);
  return current.has(id);
}
