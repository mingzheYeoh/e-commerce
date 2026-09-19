# Cloud setup — Cloudflare and Neo4j

Everything here is optional at runtime. The storefront, its search and the graph
snapshot all work as static files; these services add the things a static site
genuinely cannot do — hold a credential, run inference, and answer Cypher.

**Claude cannot do these steps.** Account creation and credential entry are
yours; each command below is safe to paste and none of them need a card.

---

## 1. Cloudflare

Free tier covers all four services used here. Workers AI has a daily allowance
measured in "neurons" that a portfolio site will not come close to exhausting.

### Sign up and authenticate

```bash
# Create the account in a browser first: https://dash.cloudflare.com/sign-up
cd worker
npx wrangler login          # opens a browser, grants the CLI access
```

### Vectorize — the retrieval index

```bash
# From the repository root
node scripts/build-vectorize.mjs

cd worker
npx wrangler vectorize create nexus-products --dimensions=384 --metric=cosine
npx wrangler vectorize insert nexus-products --file=../dist-vectorize/products.ndjson
```

384 dimensions and cosine are not arbitrary: they match `bge-small-en-v1.5`,
which `scripts/build-vectorize.mjs` runs locally and `worker/src/rag.ts` calls
through Workers AI. Both sides also use `cls` pooling — mixing pooling strategies
produces no error, only quietly worse retrieval.

### D1 — orders

```bash
npx wrangler d1 create nexus-orders
# Copy the printed database_id into wrangler.toml, replacing REPLACE_AFTER_CREATING
npx wrangler d1 execute nexus-orders --remote --file=./schema.sql
```

### Deploy

```bash
npx wrangler deploy
curl https://nexus-api.<your-subdomain>.workers.dev/api/health
```

`/api/health` reports which bindings actually resolved, so a half-configured
deploy is visible immediately rather than at the first question.

Set the site's origin once the frontend is deployed:

```bash
npx wrangler deploy --var ALLOWED_ORIGIN:https://your-site.pages.dev
```

---

## 2. Neo4j AuraDB Free

### Create the instance

1. Sign up at <https://neo4j.com/cloud/aura-free/>
2. Create a **AuraDB Free** instance
3. **Download the credentials file when it is offered — the password is shown
   once and cannot be recovered.**

### Load the graph

```bash
node scripts/build-graph.mjs        # regenerates scripts/graph.cypher

# Either paste graph.cypher into the Aura browser console, or:
cat scripts/graph.cypher | cypher-shell -a neo4j+s://<id>.databases.neo4j.io \
  -u neo4j -p '<password>'
```

The script begins with `MATCH (n) DETACH DELETE n`, so it is a full reload every
time. That is deliberate: the static snapshot is the source of truth and the
database is a projection of it, never the other way round.

### Give the Worker its credentials

```bash
cd worker
npx wrangler secret put NEO4J_URI        # neo4j+s://<id>.databases.neo4j.io
npx wrangler secret put NEO4J_USER       # neo4j
npx wrangler secret put NEO4J_PASSWORD
```

Secrets are entered interactively and never written to `wrangler.toml`, which is
committed.

### The free-tier pause

An AuraDB Free instance **pauses after 3 days of inactivity** and is deleted
after 30 unused days. For a portfolio link that someone opens weeks later, that
is a real failure mode.

Two mitigations, and the project uses both:

1. `worker/src/graph.ts` returns no rows instead of throwing whenever the
   database is unreachable, and every caller falls back to the static
   `graph.json`. A paused instance costs richer answers, not a working page.
2. A Cron Trigger keeps it warm. Add to `wrangler.toml`:

   ```toml
   [triggers]
   crons = ["0 6 */2 * *"]   # every second day
   ```

   and answer the `scheduled` event with a trivial query.

---

## What stays local, and why

| Data | Where | Reason |
|---|---|---|
| Products, specs, prices | `src/data/products.ts` | Typed, diffable, reviewable in a pull request |
| Product images | `public/media/` | 15 MB is nothing for static hosting, and no request can fail |
| MiniLM embeddings | `public/media/search/*.bin` | On-device search needs no network and leaks no query |
| Graph snapshot | `public/media/search/graph.json` | The fallback that keeps the page working when Aura sleeps |
| Vectorize copy | Cloudflare | A second retrieval backend to evaluate against the local one |
| Orders | D1 | Has to outlive the browser |
| LLM inference | Workers AI | The only thing here that truly requires a server |

Moving the catalogue itself into a database would buy nothing and add a way for
the storefront to break.
