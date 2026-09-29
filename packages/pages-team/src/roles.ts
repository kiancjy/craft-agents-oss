/**
 * Team roles for Pages — the single source of truth for who can do what.
 *
 * This table is section 4 of the product brief ("Team access for Pages"),
 * verbatim. Every permission check on both ports goes through `can()`; no
 * other file compares role names. The browser UI reads the same table (via
 * the `can` map in the state response) only to hide controls — the server
 * re-checks every request.
 *
 * Pure and runtime-neutral (no Bun/Node APIs): the Electron renderer and
 * server-core import it too.
 */

export const TEAM_ROLES = ['viewer', 'commenter', 'editor', 'admin'] as const
export type TeamRole = (typeof TEAM_ROLES)[number]

/** A role as resolved for one request: a team role, the Owner, or none. */
export type EffectiveRole = TeamRole | 'owner' | 'none'

/** The "Everyone at Incredible" rule. The brief allows only these three. */
export const GENERAL_RULES = ['none', 'viewer', 'commenter'] as const
export type GeneralRule = (typeof GENERAL_RULES)[number]

export const TEAM_ACTIONS = [
  'read_page',
  'read_threads',
  'comment',
  'edit_own_comment',
  'resolve_own_thread',
  'resolve_any_thread',
  'change_input',
  'manage_people',
  'run_source_action',
  'change_design',
  'change_owner',
] as const
export type TeamAction = (typeof TEAM_ACTIONS)[number]

type Row = Record<Exclude<EffectiveRole, 'none'>, boolean>

/** Brief §4. "Not applicable" for the Owner changing the Owner is `false`. */
export const ROLE_TABLE: Record<TeamAction, Row> = {
  read_page:          { viewer: true,  commenter: true,  editor: true,  admin: true,  owner: true },
  read_threads:       { viewer: true,  commenter: true,  editor: true,  admin: true,  owner: true },
  comment:            { viewer: false, commenter: true,  editor: true,  admin: true,  owner: true },
  edit_own_comment:   { viewer: false, commenter: true,  editor: true,  admin: true,  owner: true },
  resolve_own_thread: { viewer: false, commenter: true,  editor: true,  admin: true,  owner: true },
  resolve_any_thread: { viewer: false, commenter: false, editor: true,  admin: true,  owner: true },
  change_input:       { viewer: false, commenter: false, editor: true,  admin: true,  owner: true },
  manage_people:      { viewer: false, commenter: false, editor: false, admin: true,  owner: true },
  run_source_action:  { viewer: false, commenter: false, editor: false, admin: false, owner: true },
  change_design:      { viewer: false, commenter: false, editor: false, admin: false, owner: true },
  change_owner:       { viewer: false, commenter: false, editor: false, admin: false, owner: false },
}

/** Human labels, used by both UIs. */
export const ROLE_LABELS: Record<EffectiveRole, string> = {
  none: 'No access',
  viewer: 'Viewer',
  commenter: 'Commenter',
  editor: 'Editor',
  admin: 'Admin',
  owner: 'Owner',
}

export function can(role: EffectiveRole, action: TeamAction): boolean {
  if (role === 'none') return false
  return ROLE_TABLE[action][role]
}

/** Every action with its answer for one role — sent to the browser to hide controls. */
export function capabilities(role: EffectiveRole): Record<TeamAction, boolean> {
  const out = {} as Record<TeamAction, boolean>
  for (const action of TEAM_ACTIONS) out[action] = can(role, action)
  return out
}

const RANK: Record<EffectiveRole, number> = {
  none: 0,
  viewer: 1,
  commenter: 2,
  editor: 3,
  admin: 4,
  owner: 5,
}

/** Brief §5.1: if a personal role and the general rule both apply, the higher role wins. */
export function higherRole(a: EffectiveRole, b: EffectiveRole): EffectiveRole {
  return RANK[a] >= RANK[b] ? a : b
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value)
}

export function isGeneralRule(value: unknown): value is GeneralRule {
  return typeof value === 'string' && (GENERAL_RULES as readonly string[]).includes(value)
}

/**
 * Resolve the effective role of a signed-in person on one page.
 *
 * - The configured Owner email is always the Owner.
 * - An address outside the allowed domain gets no access, even if it is in
 *   the people list and even if the sign-in gate let it through.
 * - Otherwise the higher of the personal role and the general rule wins.
 */
export function resolveRole(input: {
  email: string
  ownerEmail: string
  allowedDomain: string
  personalRole: TeamRole | null
  generalRule: GeneralRule
}): EffectiveRole {
  const email = normalizeEmail(input.email)
  if (email === normalizeEmail(input.ownerEmail)) return 'owner'
  if (!isInDomain(email, input.allowedDomain)) return 'none'
  return higherRole(input.personalRole ?? 'none', input.generalRule)
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isInDomain(email: string, domain: string): boolean {
  const at = email.lastIndexOf('@')
  if (at <= 0) return false
  return email.slice(at + 1).toLowerCase() === domain.trim().toLowerCase()
}
