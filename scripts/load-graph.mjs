/**
 * Loads scripts/graph.cypher into Neo4j over the HTTP Query API.
 *
 * Reads credentials from the file Aura hands out at instance creation, so no
 * password is typed, pasted or left in a shell history. Nothing is printed
 * except statement outcomes.
 *
 *   node scripts/load-graph.mjs "<path to Neo4j-xxxx-Created-....txt>"
 *
 * Aura names the database and the user after the instance id, not "neo4j", so
 * both are read from the file rather than assumed.
 */
import fs from 'node:fs/promises'

const credsPath = process.argv[2]
if (!credsPath) {
  console.error('usage: node scripts/load-graph.mjs <credentials-file>')
  process.exit(1)
}

const creds = Object.fromEntries(
  (await fs.readFile(credsPath, 'utf8'))
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const host = (creds.NEO4J_URI ?? '').replace(/^neo4j\+s?:\/\//, '').replace(/\/$/, '')
const database = creds.NEO4J_DATABASE || 'neo4j'
const user = creds.NEO4J_USERNAME || creds.NEO4J_USER || 'neo4j'
const password = creds.NEO4J_PASSWORD

if (!host || !password) {
  console.error('credentials file is missing NEO4J_URI or NEO4J_PASSWORD')
  process.exit(1)
}

const endpoint = `https://${host}/db/${database}/query/v2`
const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')

async function run(statement) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: auth },
    body: JSON.stringify({ statement }),
  })
  const body = await res.json()
  if (!res.ok || body.errors?.length) {
    throw new Error(body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`)
  }
  return body
}

/**
 * Splits on semicolons that end a statement.
 *
 * The node batches embed product titles containing quotes and semicolons, so a
 * naive split corrupts them — only a semicolon at the end of a line terminates
 * a statement in this generated file.
 */
const source = await fs.readFile('scripts/graph.cypher', 'utf8')
const statements = source
  .split(/\r?\n/)
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n')
  .split(/;\s*(?:\r?\n|$)/)
  .map((s) => s.trim())
  .filter(Boolean)

console.log(`endpoint: ${endpoint}`)
console.log(`statements: ${statements.length}\n`)

let failed = 0
for (const [i, statement] of statements.entries()) {
  const label = statement.split(/\s+/).slice(0, 3).join(' ').slice(0, 46)
  try {
    await run(statement)
    console.log(`  ${String(i + 1).padStart(2)}. ok    ${label}`)
  } catch (err) {
    failed++
    console.log(`  ${String(i + 1).padStart(2)}. FAIL  ${label}\n        ${err.message.slice(0, 160)}`)
  }
}

const counts = await run(
  'MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY n DESC',
)
const rels = await run('MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n ORDER BY n DESC')

console.log(`\nnodes:`)
for (const [label, n] of counts.data.values) console.log(`  ${String(n).padStart(4)}  ${label}`)
console.log(`relationships:`)
for (const [type, n] of rels.data.values) console.log(`  ${String(n).padStart(4)}  ${type}`)

const totalNodes = counts.data.values.reduce((s, [, n]) => s + n, 0)
const totalRels = rels.data.values.reduce((s, [, n]) => s + n, 0)
console.log(`\ntotal: ${totalNodes} nodes, ${totalRels} relationships, ${failed} statement(s) failed`)
process.exit(failed ? 1 : 0)
