import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useCompareStore, validIds, MAX_COMPARE } from './compare'
import { catalogueStatus } from './catalog'
import { products } from '@/data/products'

// These describe the settled catalogue: an unknown id is gone for good. Before
// the live fetch answers, an unknown id is held instead - see the last suite.
beforeEach(() => {
  catalogueStatus.value = 'live'
})
afterAll(() => {
  catalogueStatus.value = 'pending'
})

const inCategory = (c: string) => products.filter((p) => p.category === c)
const phones = inCategory('phones')
const laptops = inCategory('computing')

describe('compare store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('locks the category to whatever went in first', () => {
    // The rule the whole feature rests on. A table whose columns are a phone
    // and a laptop has no row that means anything in both.
    const compare = useCompareStore()
    expect(compare.add(phones[0])).toBe(true)
    expect(compare.category).toBe('phones')

    expect(compare.add(laptops[0]), 'a laptop must not join a phone comparison').toBe(false)
    expect(compare.ids).toEqual([phones[0].id])
  })

  it('reports in advance what it would refuse', () => {
    // What the checkbox reads to decide whether to grey itself out. It must
    // agree with `add`, or the UI promises something the store then denies.
    const compare = useCompareStore()
    compare.add(phones[0])
    expect(compare.canAdd(phones[1])).toBe(true)
    expect(compare.canAdd(laptops[0])).toBe(false)
    // Already selected: the control is a toggle, and taking one back out is
    // always allowed.
    expect(compare.canAdd(phones[0])).toBe(true)
  })

  it('releases the lock when the last product leaves', () => {
    const compare = useCompareStore()
    compare.add(phones[0])
    compare.remove(phones[0].id)
    expect(compare.category).toBeNull()
    expect(compare.add(laptops[0])).toBe(true)
  })

  it('accepts the fourth product and refuses the fifth', () => {
    const compare = useCompareStore()
    for (const p of phones.slice(0, MAX_COMPARE)) expect(compare.add(p)).toBe(true)
    expect(compare.ids).toHaveLength(MAX_COMPARE)
    expect(compare.add(phones[MAX_COMPARE])).toBe(false)
    expect(compare.ids).toHaveLength(MAX_COMPARE)
  })

  it('adding the same product twice is a no-op, not a duplicate column', () => {
    const compare = useCompareStore()
    compare.add(phones[0])
    compare.add(phones[0])
    expect(compare.ids).toEqual([phones[0].id])
  })

  it('toggles a product out and reports that it left', () => {
    const compare = useCompareStore()
    expect(compare.toggle(phones[0])).toBe(true)
    expect(compare.toggle(phones[0])).toBe(false)
    expect(compare.ids).toEqual([])
  })

  it('needs two columns before it is a comparison', () => {
    const compare = useCompareStore()
    compare.add(phones[0])
    expect(compare.ready).toBe(false)
    compare.add(phones[1])
    expect(compare.ready).toBe(true)
  })
})

describe('validIds', () => {
  it('drops ids no product answers to', () => {
    expect(validIds([phones[0].id, 'no-such-product'])).toEqual([phones[0].id])
  })

  it('drops everything after the first category', () => {
    // A shared link is user input. Someone editing ?ids= by hand gets a smaller
    // comparison, never a table with a mouse in the phone column.
    expect(validIds([phones[0].id, laptops[0].id, phones[1].id])).toEqual([
      phones[0].id,
      phones[1].id,
    ])
  })

  it('caps the list rather than rendering a table nobody can read', () => {
    expect(validIds(phones.slice(0, 8).map((p) => p.id))).toHaveLength(MAX_COMPARE)
  })

  it('drops duplicates and anything that is not a string', () => {
    expect(validIds([phones[0].id, phones[0].id, 42, null, { id: 'x' }])).toEqual([phones[0].id])
  })

  it('survives a payload that is nothing like a list of ids', () => {
    expect(validIds([])).toEqual([])
  })
})

describe('persistence', () => {
  it('reads back only what is still valid', () => {
    // Storage outlives builds. A product delisted since the selection was made
    // must not resurrect as a blank column.
    localStorage.setItem('nexus:compare', JSON.stringify([phones[0].id, 'discontinued-thing']))
    setActivePinia(createPinia())
    expect(useCompareStore().ids).toEqual([phones[0].id])
  })

  it('ignores storage holding something that is not a list', () => {
    localStorage.setItem('nexus:compare', '{"not":"an array"}')
    setActivePinia(createPinia())
    expect(useCompareStore().ids).toEqual([])
  })

  it('survives storage being unavailable', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    setActivePinia(createPinia())
    expect(() => useCompareStore().ids).not.toThrow()
    Storage.prototype.getItem = original
  })
})

describe('setAt — the dropdown on /compare', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('swaps one column without disturbing the others', () => {
    const compare = useCompareStore()
    compare.add(phones[0])
    compare.add(phones[1])

    expect(compare.setAt(0, phones[2].id)).toBe(true)
    expect(compare.ids).toEqual([phones[2].id, phones[1].id])
  })

  it('fills the empty slot at the end', () => {
    const compare = useCompareStore()
    compare.add(phones[0])

    expect(compare.setAt(1, phones[1].id)).toBe(true)
    expect(compare.ids).toEqual([phones[0].id, phones[1].id])
  })

  it('refuses a swap that would strand the other columns', () => {
    /*
     * Column 0 sets the category for everything after it. Changing it to a
     * laptop while a second phone is in the table would drop that phone —
     * quietly, because validIds returns what survives. So the shorter result
     * is refused outright and the picker keeps its old value.
     */
    const compare = useCompareStore()
    compare.add(phones[0])
    compare.add(phones[1])

    expect(compare.setAt(0, laptops[0].id)).toBe(false)
    expect(compare.ids).toEqual([phones[0].id, phones[1].id])
  })

  it('lets the only column change category freely', () => {
    // With nothing to strand, there is nothing to protect.
    const compare = useCompareStore()
    compare.add(phones[0])

    expect(compare.setAt(0, laptops[0].id)).toBe(true)
    expect(compare.category).toBe('computing')
  })

  it('will not put the same product in two columns', () => {
    const compare = useCompareStore()
    compare.add(phones[0])
    compare.add(phones[1])

    expect(compare.setAt(1, phones[0].id)).toBe(false)
    expect(compare.ids).toEqual([phones[0].id, phones[1].id])
  })

  it('ignores a slot that is not there, and an id that is not a product', () => {
    const compare = useCompareStore()
    compare.add(phones[0])

    expect(compare.setAt(5, phones[1].id), 'past the cap').toBe(false)
    expect(compare.setAt(3, phones[1].id), 'past the first empty slot').toBe(false)
    expect(compare.setAt(-1, phones[1].id)).toBe(false)
    expect(compare.setAt(0, 'not-a-product')).toBe(false)
    expect(compare.ids).toEqual([phones[0].id])
  })

  it('treats re-picking what is already there as a success', () => {
    // The select fires change events for reasons other than a real choice;
    // reporting failure would make the page put the value back for no reason.
    const compare = useCompareStore()
    compare.add(phones[0])
    expect(compare.setAt(0, phones[0].id)).toBe(true)
  })

  it('fills every slot up to the cap and then stops', () => {
    const compare = useCompareStore()
    for (let i = 0; i < MAX_COMPARE; i++) expect(compare.setAt(i, phones[i].id)).toBe(true)
    expect(compare.ids).toHaveLength(MAX_COMPARE)
    expect(compare.setAt(MAX_COMPARE, phones[MAX_COMPARE].id)).toBe(false)
  })
})

describe('before the live catalogue answers', () => {
  it('holds an id the snapshot does not know, and drops it once settled', () => {
    // A product published since the build is unknown to the snapshot, so a
    // selection or a shared link naming it must survive until the live list
    // can say whether it exists. main.ts re-validates when it arrives.
    catalogueStatus.value = 'pending'
    localStorage.setItem('nexus:compare', JSON.stringify([phones[0].id, 'published-yesterday']))
    setActivePinia(createPinia())
    const compare = useCompareStore()
    expect(compare.ids).toEqual([phones[0].id, 'published-yesterday'])
    expect(compare.items.map((p) => p.id), 'only what resolves is shown').toEqual([phones[0].id])

    catalogueStatus.value = 'live'
    compare.setFromIds(compare.ids)
    expect(compare.ids).toEqual([phones[0].id])
  })
})
