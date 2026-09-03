// Content areas a story can belong to. Each area has an SLT member
// responsible for checking its stories before they reach the newsletter.
const SECTIONS = {
  whole_school: 'Whole School',
  foundation: 'Foundation',
  primary: 'Primary',
  secondary: 'Secondary',
  sixth_form: 'Sixth Form',
  co_curricular: 'Co-Curricular',
};

const SECTION_KEYS = Object.keys(SECTIONS);
const DEFAULT_SECTION = 'whole_school';

function sectionLabel(key) {
  return SECTIONS[key] || String(key || '').replace(/_/g, ' ');
}

function isSection(key) {
  return SECTION_KEYS.includes(key);
}

module.exports = { SECTIONS, SECTION_KEYS, DEFAULT_SECTION, sectionLabel, isSection };
