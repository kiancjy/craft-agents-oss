/**
 * Role table test — one test for each cell of the roles table in section 4
 * of the product brief. The expected grid is typed in here from the brief,
 * independently of ROLE_TABLE, so a change to either one fails a test.
 */

import { describe, expect, test } from 'bun:test'
import { type EffectiveRole, type TeamAction, can, higherRole, resolveRole } from '../src/roles.ts'

// Columns: Viewer, Commenter, Editor, Admin, Owner. "Not applicable" = No.
const BRIEF_TABLE = `
read_page           Yes Yes Yes Yes Yes
read_threads        Yes Yes Yes Yes Yes
comment             No  Yes Yes Yes Yes
edit_own_comment    No  Yes Yes Yes Yes
resolve_own_thread  No  Yes Yes Yes Yes
resolve_any_thread  No  No  Yes Yes Yes
change_input        No  No  Yes Yes Yes
manage_people       No  No  No  Yes Yes
run_source_action   No  No  No  No  Yes
change_design       No  No  No  No  Yes
change_owner        No  No  No  No  No
`

const COLUMNS: EffectiveRole[] = ['viewer', 'commenter', 'editor', 'admin', 'owner']

const cells: Array<[TeamAction, EffectiveRole, boolean]> = []
for (const line of BRIEF_TABLE.trim().split('\n')) {
  const [action, ...answers] = line.trim().split(/\s+/)
  answers.forEach((answer, i) => cells.push([action as TeamAction, COLUMNS[i]!, answer === 'Yes']))
}

describe('roles table (brief section 4)', () => {
  test('the grid has 11 actions x 5 roles', () => {
    expect(cells.length).toBe(55)
  })

  test.each(cells)('%s by %s -> %p', (action, role, expected) => {
    expect(can(role, action)).toBe(expected)
  })

  test.each([...new Set(cells.map(c => c[0]))])('%s by none -> false', action => {
    expect(can('none', action)).toBe(false)
  })
})

describe('resolveRole', () => {
  const base = { ownerEmail: 'kian@getincredible.com', allowedDomain: 'getincredible.com' }

  test('the Owner email is the Owner', () => {
    expect(resolveRole({ ...base, email: 'Kian@GetIncredible.com', personalRole: null, generalRule: 'none' })).toBe('owner')
  })

  test('an account outside the domain gets no access, even with a personal role', () => {
    expect(resolveRole({ ...base, email: 'yas@gmail.com', personalRole: 'admin', generalRule: 'commenter' })).toBe('none')
  })

  test('a look-alike domain gets no access', () => {
    expect(resolveRole({ ...base, email: 'yas@evil-getincredible.com', personalRole: 'admin', generalRule: 'viewer' })).toBe('none')
    expect(resolveRole({ ...base, email: 'yas@getincredible.com.evil.io', personalRole: 'admin', generalRule: 'viewer' })).toBe('none')
  })

  test('the higher of the personal role and the general rule wins', () => {
    expect(resolveRole({ ...base, email: 'yas@getincredible.com', personalRole: 'viewer', generalRule: 'commenter' })).toBe('commenter')
    expect(resolveRole({ ...base, email: 'yas@getincredible.com', personalRole: 'admin', generalRule: 'viewer' })).toBe('admin')
    expect(resolveRole({ ...base, email: 'yas@getincredible.com', personalRole: null, generalRule: 'viewer' })).toBe('viewer')
    expect(resolveRole({ ...base, email: 'yas@getincredible.com', personalRole: null, generalRule: 'none' })).toBe('none')
  })

  test('higherRole orders none < viewer < commenter < editor < admin < owner', () => {
    expect(higherRole('none', 'viewer')).toBe('viewer')
    expect(higherRole('editor', 'commenter')).toBe('editor')
    expect(higherRole('admin', 'owner')).toBe('owner')
  })
})
