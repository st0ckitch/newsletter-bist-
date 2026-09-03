// Named template sections. A-C are fixed parts of the layout: the header &
// quote, then always the events calendar (B, left) beside the principal's
// message (C, right). Below them the news columns lead: Primary fills the
// left column (D/F/H), Secondary and Foundation share the right (E/G/I);
// then the full-width sections follow in order - Whole School (W), Sixth
// Form (X) and Co-Curricular (Y).
const SLOT_LABELS = {
  A: 'A - Header & quote of the week (fixed)',
  B: 'B - Upcoming events · left column (fixed)',
  C: "C - Principal's message · right column (fixed)",
  W: 'W - Whole School · full width, under the columns',
  D: 'D - Primary · left column, top',
  E: 'E - Secondary/Foundation · right column, top',
  F: 'F - Primary · left column, middle',
  G: 'G - Secondary/Foundation · right column, middle',
  H: 'H - Primary · left column, bottom',
  I: 'I - Secondary/Foundation · right column, bottom',
  X: 'X - Sixth Form · full width, below the columns',
  Y: 'Y - Co-Curricular · full width, at the bottom',
};

const CONTENT_SLOTS = ['W', 'D', 'E', 'F', 'G', 'H', 'I', 'X', 'Y'];
const LEFT_SLOTS = ['D', 'F', 'H'];
const RIGHT_SLOTS = ['E', 'G', 'I'];
// The full-width bands: articles placed here render across the whole sheet,
// not inside a half-width column, so photos get the wide size treatment.
const WIDE_SLOTS = CONTENT_SLOTS.filter((s) => !LEFT_SLOTS.includes(s) && !RIGHT_SLOTS.includes(s));
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
  foundation: RIGHT_SLOTS, // single column, beside the Primary stories
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
  if (section === 'whole_school') return 'Whole School stories live in their own full-width section (W) under the columns.';
  if (section === 'foundation') return 'Foundation stories go in the right column (E/G/I), alongside Secondary.';
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
  WIDE_SLOTS,
  DEFAULT_SLOT,
  MAX_ARTICLE_WORDS,
  wordCount,
  allowedSlots,
  defaultSlot,
  columnRule,
};
