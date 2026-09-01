// Who may do what.
//
// The newsletter runs as a chain of responsibilities:
//   staff (teachers & LSAs)  submit stories and events for any area
//   SLT                      check the stories in their own area
//   marketing                lay the issue out and create the Mailchimp draft
//   principal                final proof-read, then approves it for sending
//   admin                    everything, plus accounts and configuration
//
// "primary" and "secondary" are the original teacher roles; existing
// accounts keep working and behave exactly like staff.
const ROLE_LABELS = {
  staff: 'Staff - teacher / LSA (submits stories and events)',
  slt: 'SLT - checks the stories in their area, admin rights',
  marketing: 'Marketing - lays out the issue and creates the draft',
  principal: 'Principal - final proof-read and approval to send',
  admin: 'Admin - full access, accounts and configuration',
  primary: 'Primary teacher (legacy - same as staff)',
  secondary: 'Secondary teacher (legacy - same as staff)',
};

// Offered when creating an account; the legacy roles stay valid but are not
// suggested for new people.
const ASSIGNABLE_ROLES = ['staff', 'slt', 'marketing', 'principal', 'admin'];
const ALL_ROLES = Object.keys(ROLE_LABELS);

// See and edit everyone's content (not just their own submissions).
const MANAGER_ROLES = ['slt', 'marketing', 'principal', 'admin'];
// Curate and lay out the issue: include/exclude, template sections, the live
// editor and creating the Mailchimp draft. Marketing owns this in practice.
const LAYOUT_ROLES = ['marketing', 'slt', 'principal', 'admin'];
// Check submitted stories. SLT covers its own area; principal/admin cover all.
const REVIEW_ROLES = ['slt', 'principal', 'admin'];
// Final sign-off that the issue may be sent.
const APPROVE_ROLES = ['principal', 'admin'];
// Manage accounts and school-wide settings.
const ADMIN_ROLES = ['slt', 'principal', 'admin'];
// Receive the content reminder emails.
const REMINDER_ROLES = ['staff', 'primary', 'secondary', 'slt'];

const has = (list) => (user) => Boolean(user && list.includes(user.role));

const canManage = has(MANAGER_ROLES);
const canLayout = has(LAYOUT_ROLES);
const canApproveIssue = has(APPROVE_ROLES);
const canAdminister = has(ADMIN_ROLES);
const isReviewer = has(REVIEW_ROLES);

// Everyone with an account may submit stories and events - the principal
// asked for all teachers and LSAs to be able to contribute.
function canSubmit(user) {
  return Boolean(user);
}

// SLT check their own area. A member with no area set (or "all") covers
// everything, and whole-school stories can be checked by any SLT member.
function canReviewSection(user, section) {
  if (!isReviewer(user)) return false;
  if (['principal', 'admin'].includes(user.role)) return true;
  if (!user.section || user.section === 'all') return true;
  return user.section === section || section === 'whole_school';
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

module.exports = {
  ROLE_LABELS,
  ASSIGNABLE_ROLES,
  ALL_ROLES,
  MANAGER_ROLES,
  LAYOUT_ROLES,
  REVIEW_ROLES,
  APPROVE_ROLES,
  ADMIN_ROLES,
  REMINDER_ROLES,
  canManage,
  canLayout,
  canApproveIssue,
  canAdminister,
  canSubmit,
  isReviewer,
  canReviewSection,
  roleLabel,
};
