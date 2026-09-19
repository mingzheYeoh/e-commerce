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
  /**
   * Aura does not always name the database `neo4j`.
   *
   * Newer instances use the instance id for both the database and the user, so
   * a hardcoded `/db/neo4j/` returned `DatabaseNotFound` with credentials that
   * were perfectly valid. Read it from the credentials file rather than assume.
   */
  NEO4J_DATABASE?: string
}

export interface GraphRow {
  [key: string]: unknown
}

/**
 * The HTTP Query API endpoint.
 *
 * `neo4j+s://` is the Bolt scheme; the same host serves HTTP over TLS. The
 * database segment defaults to `neo4j` for self-hosted and older Aura, but must
 * be overridable — see NEO4J_DATABASE.
 */
function endpoint(env: GraphEnv): string {
  const host = (env.NEO4J_URI ?? '')
    .replace(/^neo4j\+s?:\/\//, '')
    .replace(/^bolt(\+s)?:\/\//, '')
    .replace(/\/$/, '')
  return `https://${host}/db/${env.NEO4J_DATABASE || 'neo4j'}/query/v2`
}

/**
 * Runs a query and reports why it failed.
 *
 * `query()` swallows failures on purpose so a paused database degrades an
 * answer instead of breaking a page — but that also makes "no rows" and
 * "unreachable" indistinguishable, which is useless when something is actually
 * wrong. This variant is what /api/health uses to tell them apart.
 */
export async function queryOrError(
  env: GraphEnv,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<{ rows: GraphRow[] } | { error: string }> {
  if (!env.NEO4J_URI || !env.NEO4J_USER || !env.NEO4J_PASSWORD) {
    return { error: 'credentials not configured' }
  }

  const url = endpoint(env)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Basic ' + btoa(`${env.NEO4J_USER}:${env.NEO4J_PASSWORD}`),
      },
      body: JSON.stringify({ statement: cypher, parameters: params }),
      signal: AbortSignal.timeout(8000),
    })

    const text = await res.text()
    if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` }

    const body = JSON.parse(text) as {
      data?: { fields: string[]; values: unknown[][] }
      errors?: { message?: string }[]
    }
    if (body.errors?.length) return { error: body.errors.map((e) => e.message).join('; ').slice(0, 300) }
    if (!body.data) return { error: 'response carried no data block' }

    const { fields, values } = body.data
    return { rows: values.map((row) => Object.fromEntries(fields.map((f, i) => [f, row[i]]))) }
  } catch (err) {
    return { error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown failure' }
  }
}

/**
 * Runs a read query, returning no rows on any failure.
 *
 * Parameters are always passed separately — a Cypher string built by
 * concatenating user input is injectable in exactly the way SQL is.
 */
export async function query(
  env: GraphEnv,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<GraphRow[]> {
  if (!env.NEO4J_URI || !env.NEO4J_USER || !env.NEO4J_PASSWORD) return []

  const url = endpoint(env)

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
