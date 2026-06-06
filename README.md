# Plurality Market Backend

REST API for the Plurality Market stack. Serves the Marketplace UI (Studio + C2C + Talk-to-Memory), fronts the MCP server's PAT verification, and proxies vector / LLM calls to the AI service. Talks to:

- **Postgres** — users, memory buckets, contexts, PATs, NFT bookkeeping
- **Oasis Sapphire Testnet** — read-only for NFT-ownership-based access checks
- **`plurality-market-ai-service`** (port `8001`) — vector store + LLM
- **`plurality-market-mcp`** (port `5051`) — forwards PAT verify requests here

## Prerequisites

- Node.js `20+` (the Dockerfile pins `node:20-slim`)
- Reachable Postgres (`DB_HOST`/`DB_USER`/`DB_NAME`/`DB_PASSWORD` in `.env`)
- A funded Sapphire Testnet wallet (`BACKEND_WALLET_PRIVATE_KEY`) for any signer paths
- A running `plurality-market-ai-service` at `AI_SERVICE_URL` (default `http://localhost:8001`)

## Setup

```bash
npm install
cp .env.example .env   # if a fresh checkout
```

Fill in `.env` — at minimum:

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

# AI service
AI_SERVICE_URL=http://localhost:8001
AI_SERVICE_API_KEY=<same as ai-service CONTEXT_API_KEY>

# Blockchain (Oasis Sapphire Testnet)
BLOCKCHAIN_RPC_URL=https://testnet.sapphire.oasis.io
BACKEND_WALLET_PRIVATE_KEY=0x...
MEMORY_NFT_CONTRACT_ADDRESS=0xDe5dB30AE86e27F1E7EeC0AD353d910C4Ca93D08
CONTEXT_REGISTRY_ADDRESS=0x9A374905B2B286344fCac6f754dCF40F3cb427d5
REPUTATION_REGISTRY_ADDRESS=0x8D0027e715943FB2f215c884369B744861331E3E

API_BASE_URL=http://localhost:5000
```

> Contract addresses above are the live v5 deployment (Sapphire Testnet). See [`plurality-context-contracts/deployments.market.json`](../plurality-context-contracts/deployments.market.json) for the canonical record.

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

The container expects the same `.env` shape as local. Postgres / AI service / RPC URLs must be reachable from inside the container — use `host.docker.internal` (Docker Desktop) or a shared compose network for siblings on the same host.

## Common entry points

| Path | Purpose |
|---|---|
| `/auth/siwe/*` | Sign-In-With-Ethereum (the only auth surface used by the market UI) |
| `/pat/tokens` | Mint / list / revoke Personal Access Tokens for the MCP server |
| `/pat/tokens/verify` | Called by the MCP server on every request — verifies the bearer PAT and returns the owner's wallet + scopes |
| `/ai/profile` | Memory-bucket (AI profile) CRUD |
| `/ai/context` | Per-bucket context CRUD (proxied through to the AI service) |
| `/mcp/semantic-search` | MCP tool's search endpoint (PAT-gated) |
| `/blockchain/*` | Read-only NFT-ownership lookups (cached) |

## License

MIT (per individual file headers).
