import { describe, it, expect } from 'vitest'
import { memoryD1 } from '../test/d1-memory'

/**
 * The constraints are the point of this file, so they are tested directly
 * rather than through the code that relies on them. A CHECK that was never
 * exercised is a comment.
 */
describe('the schema refuses states that must not exist', () => {
  it('will not store a merchant staff row without a merchant', async () => {
    /*
     * The obvious encoding is "merchant_id IS NULL means platform". That is
     * the shape of a privilege-escalation bug: anything that nulls the column
     * issues a platform pass. The paired CHECK makes it unrepresentable.
     */
    const { raw } = memoryD1()
    raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status)
                 VALUES ('mch_a','a','A','MYR','active')`).run()

    expect(() =>
      raw
        .prepare(
          `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt, iterations, kdf_rounds)
           VALUES ('stf_1','a@x.co','merchant',NULL,'owner','h','s',100000,6)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it('will not store a platform staff row that belongs to a merchant', async () => {
    const { raw } = memoryD1()
    raw.prepare(`INSERT INTO merchants (id, slug, name, settlement_currency, status)
                 VALUES ('mch_a','a','A','MYR','active')`).run()

    expect(() =>
      raw
        .prepare(
          `INSERT INTO staff (id, email, scope, merchant_id, role, password_hash, password_salt, iterations, kdf_rounds)
           VALUES ('stf_2','b@x.co','platform','mch_a','admin','h','s',100000,6)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/)
  })

  it('refuses to rewrite or erase the audit log', async () => {
    // A log whose history can be edited is not a log.
    const { raw } = memoryD1()
    raw
      .prepare(
        `INSERT INTO audit_log (id, actor_id, actor_scope, action) VALUES ('aud_1','stf_1','platform','orders.read')`,
      )
      .run()

    expect(() => raw.prepare(`UPDATE audit_log SET action = 'nothing'`).run()).toThrow(
      /append-only/,
    )
    expect(() => raw.prepare(`DELETE FROM audit_log`).run()).toThrow(/append-only/)
  })

  it('keeps sku unique per merchant rather than globally', async () => {
    // Two merchants may both sell IP18P-256. A global unique would make the
    // second merchant to list it unable to.
    const { raw } = memoryD1()
    for (const id of ['mch_a', 'mch_b']) {
      raw
        .prepare(
          `INSERT INTO merchants (id, slug, name, settlement_currency, status) VALUES (?, ?, 'M','MYR','active')`,
        )
        .run(id, id)
    }
    const insert = raw.prepare(
      `INSERT INTO products (id, merchant_id, sku, title, brand, category, price_minor, currency, status)
       VALUES (?, ?, 'IP18P-256','Phone','APPLE','phones',119900,'MYR','published')`,
    )
    insert.run('p_a', 'mch_a')
    expect(() => insert.run('p_b', 'mch_b'), 'a different merchant, same sku').not.toThrow()
    expect(() => insert.run('p_c', 'mch_a'), 'the same merchant twice').toThrow(/UNIQUE/)
  })
})
