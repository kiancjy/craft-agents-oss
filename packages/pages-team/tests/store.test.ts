import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { TeamStore, TeamStoreError } from '../src/store.ts'
import { makeWorkspace } from './helpers.ts'

const kian = { email: 'kian@getincredible.com', name: 'Kian' }
const yas = { email: 'yas@getincredible.com', name: 'Yas' }

function openStore() {
  const root = makeWorkspace([{ slug: 'demo' }])
  const folder = join(root, 'pages', 'demo')
  return { folder, store: TeamStore.open(folder) }
}

describe('TeamStore', () => {
  test('people: add, change role, remove, with a change record that names the person', () => {
    const { store } = openStore()
    store.setPerson('Yas@GetIncredible.com', 'commenter', kian)
    expect(store.getPersonalRole('yas@getincredible.com')).toBe('commenter')
    store.setPerson('yas@getincredible.com', 'admin', kian)
    expect(store.listPeople()).toEqual([
      expect.objectContaining({ email: 'yas@getincredible.com', role: 'admin', addedBy: 'kian@getincredible.com' }),
    ])
    expect(store.removePerson('yas@getincredible.com', yas)).toBe(true)
    expect(store.getPersonalRole('yas@getincredible.com')).toBeNull()
    const actions = store.listChanges().map(c => `${c.actorEmail} ${c.action}`)
    expect(actions).toEqual([
      'yas@getincredible.com person.remove',
      'kian@getincredible.com person.role',
      'kian@getincredible.com person.add',
    ])
  })

  test('general rule defaults to none and records the change', () => {
    const { store } = openStore()
    expect(store.getGeneralRule()).toBe('none')
    store.setGeneralRule('commenter', kian)
    expect(store.getGeneralRule()).toBe('commenter')
    expect(store.listChanges()[0]).toEqual(expect.objectContaining({ action: 'general_rule.set', detail: { from: 'none', to: 'commenter' } }))
  })

  test('threads: create, reply, resolve, reopen', () => {
    const { store } = openStore()
    const thread = store.createThread('  First point  ', yas)
    expect(thread.comments[0]!.body).toBe('First point')
    store.addReply(thread.id, 'A reply', kian)
    expect(store.countOpenThreads()).toBe(1)
    store.setResolved(thread.id, true, kian)
    expect(store.countOpenThreads()).toBe(0)
    expect(store.getThread(thread.id)!.resolvedBy).toBe('kian@getincredible.com')
    store.setResolved(thread.id, false, yas)
    expect(store.getThread(thread.id)!.resolvedAt).toBeNull()
    expect(store.getThread(thread.id)!.comments.map(c => c.authorName)).toEqual(['Yas', 'Kian'])
  })

  test('only the author edits or deletes a comment; delete keeps the row and the record keeps the text', () => {
    const { store } = openStore()
    const thread = store.createThread('Original', yas)
    const commentId = thread.comments[0]!.id
    expect(() => store.editComment(commentId, 'Hijack', kian)).toThrow(TeamStoreError)
    store.editComment(commentId, 'Edited', yas)
    expect(store.getComment(commentId)!.editedAt).not.toBeNull()
    store.deleteComment(commentId, yas)
    const deleted = store.getComment(commentId)!
    expect(deleted.deleted).toBe(true)
    expect(deleted.body).toBe('')
    expect(store.listChanges()[0]!.detail).toEqual({ commentId, previous: 'Edited' })
  })

  test('empty and too long comments are refused', () => {
    const { store } = openStore()
    expect(() => store.createThread('   ', yas)).toThrow('The comment is empty.')
    expect(() => store.createThread('x'.repeat(5001), yas)).toThrow(TeamStoreError)
  })

  test('two comments saved at the same time from two connections are both kept', async () => {
    const { folder, store } = openStore()
    const thread = store.createThread('Start', kian)
    const a = TeamStore.open(folder)
    const b = TeamStore.open(folder)
    await Promise.all([
      Promise.resolve().then(() => a.addReply(thread.id, 'From A', yas)),
      Promise.resolve().then(() => b.addReply(thread.id, 'From B', kian)),
    ])
    a.close()
    b.close()
    const bodies = store.getThread(thread.id)!.comments.map(c => c.body).sort()
    expect(bodies).toEqual(['From A', 'From B', 'Start'])
  })

  test('two processes writing at the same time both keep their comments', async () => {
    const { folder, store } = openStore()
    const thread = store.createThread('Start', kian)
    const script = (label: string) => `
      import { TeamStore } from ${JSON.stringify(join(import.meta.dir, '../src/store.ts'))}
      const s = TeamStore.open(${JSON.stringify(folder)})
      for (let i = 0; i < 25; i++) s.addReply(${JSON.stringify(thread.id)}, '${label}-' + i, { email: '${label}@getincredible.com', name: '${label}' })
      s.close()
    `
    const procs = ['a', 'b'].map(label => Bun.spawn(['bun', '-e', script(label)], { stderr: 'pipe' }))
    const codes = await Promise.all(procs.map(p => p.exited))
    expect(codes).toEqual([0, 0])
    expect(store.getThread(thread.id)!.comments.length).toBe(51)
  })
})
