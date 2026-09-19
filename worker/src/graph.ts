/**
 * Neo4j access from a Cloudflare Worker.
 *
 * The official driver speaks Bolt, which is a raw TCP protocol; Workers only
 * give outbound `fetch`. Aura also exposes an HTTP Query API, so that is what
 * this uses — the trade is one round trip per query instead of a pooled
 * connection, which for a storefront question is irrelevant.
 *
 * Every call is wrapped so that a paused free-tier instance, an expired
 * credential or a network failure returns no rows rather than throwing. The
 * static graph snapshot answers the same questions client-side, so losing the
 * database degrades the answer instead of breaking the page.
 */

export interface GraphEnv {
  NEO4J_URI?: string
  NEO4J_USER?: string
  NEO4J_PASSWORD?: string
}

export interface GraphRow {
  [key: string]: unknown
}

/**
 * Runs a read query. Parameters are always passed separately — a Cypher string
 * built by concatenating user input is injectable in exactly the way SQL is.
 */
export async function query(
  env: GraphEnv,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<GraphRow[]> {
  if (!env.NEO4J_URI || !env.NEO4J_USER || !env.NEO4J_PASSWORD) return []

  // neo4j+s://xxx.databases.neo4j.io -> https://xxx.databases.neo4j.io
  const host = env.NEO4J_URI.replace(/^neo4j\+s?:\/\//, '').replace(/^bolt(\+s)?:\/\//, '')
  const url = `https://${host}/db/neo4j/query/v2`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Basic ' + btoa(`${env.NEO4J_USER}:${env.NEO4J_PASSWORD}`),
      },
      body: JSON.stringify({ statement: cypher, parameters: params }),
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return []

    const body = (await res.json()) as {
      data?: { fields: string[]; values: unknown[][] }
      errors?: unknown[]
    }
    if (body.errors?.length || !body.data) return []

    const { fields, values } = body.data
    return values.map((row) => Object.fromEntries(fields.map((f, i) => [f, row[i]])))
  } catch {
    // Paused instance, bad credentials, timeout. The caller falls back.
    return []
  }
}

/* ------------------------------------------------------------------ queries */

/**
 * The structured questions embeddings answer badly.
 *
 * Each is a fixed query with bound parameters rather than generated Cypher: a
 * language model writing its own graph queries against a live database is a
 * much larger attack surface than a shopper needs.
 */

export const facts = {
  /** Products that satisfy a numeric floor, e.g. "charges at 60W or more". */
  atLeast: (env: GraphEnv, property: string, value: number, limit = 6) => {
    // The property name is interpolated, so it is checked against a fixed list
    // first; only these can ever reach the query.
    const allowed = ['chargeWatts', 'batteryHours', 'batteryMah', 'refreshHz', 'megapixels', 'storageGb', 'memoryGb', 'screenInches']
    if (!allowed.includes(property)) return Promise.resolve([])
    return query(
      env,
      `MATCH (p:Product) WHERE p.${property} >= $value
       RETURN p.id AS id, p.title AS title, p.${property} AS value, p.price AS price
       ORDER BY p.${property} DESC LIMIT $limit`,
      { value, limit },
    )
  },

  /** Alternatives at a comparable price, which is what "similar to" means. */
  rivals: (env: GraphEnv, id: string, limit = 5) =>
    query(
      env,
      `MATCH (p:Product {id: $id})-[r:COMPETES_WITH]-(o:Product)
       RETURN o.id AS id, o.title AS title, o.price AS price, r.priceRatio AS ratio
       ORDER BY r.priceRatio DESC LIMIT $limit`,
      { id, limit },
    ),

  /** What can charge this, following the connector rather than guessing. */
  powerFor: (env: GraphEnv, id: string) =>
    query(
      env,
      `MATCH (c:Product)-[:POWERS]->(p:Product {id: $id})
       RETURN c.id AS id, c.title AS title, c.chargeWatts AS watts
       ORDER BY c.chargeWatts DESC`,
      { id },
    ),

  /** Everything with a capability, e.g. "which ones cancel noise". */
  withFeature: (env: GraphEnv, feature: string, limit = 8) =>
    query(
      env,
      `MATCH (p:Product)-[:HAS_FEATURE]->(f:Feature {id: $feature})
       RETURN p.id AS id, p.title AS title, p.price AS price
       ORDER BY p.rating DESC LIMIT $limit`,
      { feature, limit },
    ),

  /**
   * Two hops: accessories for a product's stablemates. The query embeddings
   * cannot do at all, because it is a path, not a similarity.
   */
  accessoriesForBrand: (env: GraphEnv, brand: string, limit = 8) =>
    query(
      env,
      `MATCH (b:Brand {id: $brand})<-[:MADE_BY]-(p:Product)<-[:PAIRS_WITH]-(a:Product)
       WHERE a.id <> p.id
       RETURN DISTINCT a.id AS id, a.title AS title, a.price AS price
       ORDER BY a.price LIMIT $limit`,
      { brand, limit },
    ),
}
