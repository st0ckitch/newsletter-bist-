// Named template sections. A-C are fixed parts of the layout. Each area of
// school life has its own dedicated place: Whole School runs full width under
// the header (W), Primary fills the left column (D/F/H), Secondary the right
// (E/G/I), and Sixth Form (X) and Co-Curricular (Y) run full width below the
// columns.
const SLOT_LABELS = {
  A: 'A - Header & quote of the week (fixed)',
  B: 'B - Upcoming events · left column (fixed)',
  C: "C - Principal's message · right column (fixed)",
  W: 'W - Whole School · full width, under the header',
  D: 'D - Primary · left column, top',
  E: 'E - Secondary · right column, top',
  F: 'F - Primary · left column, middle',
  G: 'G - Secondary · right column, middle',
  H: 'H - Primary · left column, bottom',
  I: 'I - Secondary · right column, bottom',
  V: 'V - Foundation · full width, below the columns',
  X: 'X - Sixth Form · full width, below the columns',
  Y: 'Y - Co-Curricular · full width, at the bottom',
};

const CONTENT_SLOTS = ['W', 'D', 'E', 'F', 'G', 'H', 'I', 'V', 'X', 'Y'];
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

// Placement policy: the area decides where a story can go. Primary owns the
// left column, Secondary the right, and Whole School / Sixth Form /
// Co-Curricular each have a dedicated full-width section of their own.
const SECTION_SLOTS = {
  whole_school: ['W'],
  foundation: ['V'],
  primary: LEFT_SLOTS,
  secondary: RIGHT_SLOTS,
  sixth_form: ['X'],
  co_curricular: ['Y'],
};

function allowedSlots(section) {
  return SECTION_SLOTS[section] || CONTENT_SLOTS;
}

// Topmost allowed slot: D for left-column and either-column areas, E for secondary.
function defaultSlot(section) {
  return allowedSlots(section)[0];
}

// The human-readable rule behind a refused placement (null = no restriction).
function columnRule(section) {
  if (section === 'whole_school') return 'Whole School stories live in their own full-width section (W) under the header.';
  if (section === 'foundation') return 'Foundation stories live in their own full-width section (V) below the columns.';
  if (section === 'primary') return 'Primary stories always go in the left column (D/F/H).';
  if (section === 'secondary') return 'Secondary stories always go in the right column (E/G/I).';
  if (section === 'sixth_form') return 'Sixth Form stories live in their own full-width section (X) below the columns.';
  if (section === 'co_curricular') return 'Co-Curricular stories live in their own full-width section (Y) at the bottom.';
  return null;
}

module.exports = {
  SLOT_LABELS,
  CONTENT_SLOTS,
  LEFT_SLOTS,
  RIGHT_SLOTS,
  DEFAULT_SLOT,
  MAX_ARTICLE_WORDS,
  wordCount,
  allowedSlots,
  defaultSlot,
  columnRule,
};
