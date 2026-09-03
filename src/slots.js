// Named template sections. A-C are fixed parts of the layout; articles are
// placed by the admin into the lettered content slots, which map onto the
// newsletter's two columns (D/F/H = left, E/G/I = right, top to bottom).
const SLOT_LABELS = {
  A: 'A - Header & quote of the week (fixed)',
  B: 'B - Upcoming events · left column (fixed)',
  C: "C - Principal's message · right column (fixed)",
  D: 'D - Left column · top',
  E: 'E - Right column · top',
  F: 'F - Left column · middle',
  G: 'G - Right column · middle',
  H: 'H - Left column · bottom',
  I: 'I - Right column · bottom',
};

const CONTENT_SLOTS = ['D', 'E', 'F', 'G', 'H', 'I'];
const LEFT_SLOTS = ['D', 'F', 'H'];
const RIGHT_SLOTS = ['E', 'G', 'I'];
const DEFAULT_SLOT = 'D';

// Keep stories short and scannable for parents.
const MAX_ARTICLE_WORDS = 100;

function wordCount(text) {
  return String(text || '')
    .split(/\s+/)
    .filter(Boolean).length;
}

module.exports = { SLOT_LABELS, CONTENT_SLOTS, LEFT_SLOTS, RIGHT_SLOTS, DEFAULT_SLOT, MAX_ARTICLE_WORDS, wordCount };
