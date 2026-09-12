# Plurality Market Backend

REST API for the Plurality Skills Marketplace stack. Serves the Marketplace UI (Studio + C2C + Use a Skill), fronts the MCP server's PAT verification, and proxies vector / LLM calls to the AI service. Talks to:

- **Postgres**: users, Skills (memory buckets), contexts, PATs, NFT bookkeeping
- **Oasis Sapphire Testnet**: read-only for NFT-ownership-based access checks
- **`plurality-market-ai-service`** (port `8001`): vector store + LLM
- **`plurality-market-mcp`** (port `5051`): forwards PAT verify requests here

## Prerequisites

- Node.js `20+` (the Dockerfile pins `node:20-slim`)
- Reachable Postgres (`DB_HOST`/`DB_USER`/`DB_NAME`/`DB_PASSWORD` in `.env`)
- A running `plurality-market-ai-service` at `AI_SERVICE_URL` (default `http://localhost:8001`)

The backend never signs transactions: all on-chain writes are prepared as calldata and signed by the user's wallet in the browser, so no backend wallet key is needed.

## Setup

```bash
npm install
cp .env.example .env   # if a fresh checkout
```

Fill in `.env`, at minimum:

```env
PORT=5001
NODE_ENV=development

JWT_SECRET=<random 32-byte hex>
JWT_EXPIRY=365d
BACKEND_API_KEY=<shared with ai-service>

# Database
DB_HOST=...
DB_PORT=5432
DB_NAME=...
DB_USER=...
DB_PASSWORD=...
# Optional: CA bundle path for verified TLS to managed Postgres (e.g. AWS RDS)
# DB_SSL_CA_PATH=certificates/rds-ca-bundle.pem

# AI service
AI_SERVICE_URL=http://localhost:8001
AI_SERVICE_API_KEY=<same as ai-service CONTEXT_API_KEY>

# Blockchain (Oasis Sapphire Testnet)
BLOCKCHAIN_RPC_URL=https://testnet.sapphire.oasis.io
MEMORY_NFT_CONTRACT_ADDRESS=0x83C5846569156ce0Dd4b988f3c2b510423B2fcdc
CONTEXT_REGISTRY_ADDRESS=0xDBED42F3e8b860831cFb0B67dd67400f900aEB9C
REPUTATION_REGISTRY_ADDRESS=0xca998e6C770B84fbEE6319d16F4781bc1C9E9757

API_BASE_URL=http://localhost:5000
```

> Contract addresses above are the live v5 deployment on Sapphire Testnet; swap in your own deployment's addresses if you run the contracts yourself.

## Running

```bash
npm run start       # dev (ts-node-dev, auto-restart on save; runs lint+format first)
npm run prod        # prod (ts-node, no restart, no lint)
npm run swagger     # regenerate src/swagger.json from JSDoc
```

Listens on `http://localhost:${PORT}` (default `5001`). Verify with:

```bash
curl http://localhost:5001/
```

The UI's `VITE_APP_API_BASE_URL` and the MCP server's `BACKEND_API_URL` must point at this URL.

## Docker

```bash
docker build -t plurality-market-backend .
docker run -p 5001:5001 --env-file .env plurality-market-backend
```

The container expects the same `.env` shape as local. Postgres / AI service / RPC URLs must be reachable from inside the container: use `host.docker.internal` (Docker Desktop) or a shared compose network for siblings on the same host.

## Common entry points

| Path | Purpose |
|---|---|
| `/auth/siwe/*` | Sign-In-With-Ethereum (the only auth surface used by the market UI) |
| `/pat/tokens` | Mint / list / revoke Personal Access Tokens for the MCP server |
| `/pat/tokens/verify` | Called by the MCP server on every request; verifies the bearer PAT and returns the owner's wallet + scopes |
| `/ai/profile` | Skill / memory-bucket (AI profile) CRUD |
| `/ai/profile/:profileId/skill` | Skill instructions for one bucket (GET for creator or NFT holder, PUT / DELETE for the creator of a draft) |
| `/ai/context` | Per-bucket context CRUD (proxied through to the AI service) |
| `/mcp/semantic-search` | MCP tool's search endpoint (PAT-gated) |
| `/blockchain/*` | Mint / list / buy flows, public NFT metadata, read-only NFT-ownership lookups (cached) |

## Skills

A **Skill** is what the marketplace sells: *instructions* (a markdown playbook telling an agent how to behave) plus *memory* (the bucket's contexts: files, notes, chats). One bucket holds at most one skill and the skill is optional. A bucket without a custom skill still works: the API serves the built-in default skill ("Knowledge assistant", see `src/services/ai-service/utils/default-skill.ts`) flagged `isDefault: true`, and the marketplace shows it as "Knowledge only". Minting never requires a skill.

### Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/ai/profile/:profileId/skill` | session cookie or PAT (`mcp:tools`) | Creator of a draft or any wallet holding the NFT. Returns `hasSkill`, `isDefault`, `name`, `summary`, `instructions`, `skillHash`, `skillContextId`, `registeredOnChain`, `updatedAt`, `isImmutable` and a `memoryIndex` (completed contexts, max 50). Falls back to the default skill when none is set. |
| `PUT` | `/ai/profile/:profileId/skill` | session cookie | Creator only, drafts only. Body `{ name, summary?, instructions }`: name 1 to 80 chars, summary up to 280, instructions 1 to 20000 chars of markdown. Responds with the same shape as GET. |
| `DELETE` | `/ai/profile/:profileId/skill` | session cookie | Creator only, drafts only. Clears the skill; the bucket falls back to the default skill. 204. |
| `GET` | `/blockchain/metadata/skill/:profileId` | public | Metadata the on-chain skill entry points to: `{ name, description, properties: { skillHash, skillContextId, bucketHash } }`. 404 until the bucket is frozen. |

Editing or deleting a skill on a minted bucket returns `403 { error: "bucket_immutable" }`, the same rule contexts follow.

Visibility: `skillName` and `skillSummary` are public (they appear in `GET /ai/profile`, in the NFT serializers and in the tokenURI metadata). `skillInstructions` are never included in a list or public metadata response; only `GET /ai/profile/:profileId/skill` returns them, gated by `resolveProfileAccess`.

### Hashing and on-chain registration

- Instructions are normalized (CRLF to LF, trimmed) and hashed with SHA-256 into `skillHash` (`0x` + 64 hex).
- `bucketHash` = SHA-256 of `[skillHash (if present), ...contextHashes]` in `(createdAt ASC, contextId ASC)` order. A bucket without a skill hashes exactly as before, so existing hashes and NFTs are unaffected.
- `skillContextId` is a UUID assigned on the first save and never rotated. At `POST /blockchain/mint/:profileId/prepare-registration` the skill is placed as the **first** item of the `registerContextBatch` call with `sourceType = "skill"` and a metadata URI of `/blockchain/metadata/skill/:profileId`. `confirm-registration` verifies it through `ContextRegistry.verifyContent` and sets `skillRegisteredOnChain`.
- The bucket tokenURI (`/blockchain/metadata/bucket/:profileId`) gains a `Skill` attribute plus `skillHash` / `skillContextId` properties when a skill is present.

No contract changes were needed: the registry already accepts arbitrary source types.

## License

MIT (per individual file headers).
