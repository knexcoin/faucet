# KnexCoin Testnet Faucet

Cloudflare Workers-based faucet for distributing testnet KNEX coins.

**Live:** [https://faucet.knexcoins.com](https://faucet.knexcoins.com)

## Features

- Serverless architecture on Cloudflare Workers (free tier)
- Cloudflare Turnstile for bot protection
- KV storage for rate limiting
- Cyberpunk neon UI theme
- Test mode for development

## Anti-Spam Protection

| Layer | Protection | Description |
|-------|------------|-------------|
| 1 | **Cloudflare Turnstile** | Invisible bot detection |
| 2 | **Per-Address Rate Limit** | 1 claim per address per 24 hours |
| 3 | **Per-IP Rate Limit** | 10 claims per IP per hour |
| 4 | **Address Validation** | Only valid K... addresses accepted |

## Address Format

KnexCoin addresses use the following format:
- **Prefix:** `K` (capital letter)
- **Length:** 56 characters total
- **Encoding:** Base32 (A-Z, 2-7)
- **Example:** `KABC2DEF3GHI4JKL5MNO6PQR7STU2VWX3YZ4ABC5DEF6GHI7JKL`

## Cost

| Tier | Monthly Cost | Capacity |
|------|-------------|----------|
| Free | $0 | ~3,000 claims/day |
| Pro | $5 | ~10,000 claims/day |

## Setup Instructions

### 1. Prerequisites

```bash
npm install -g wrangler
wrangler login
```

### 2. Clone and Install

```bash
git clone https://github.com/knexcoin/faucet.git
cd faucet
npm install
```

### 3. Create KV Namespaces

```bash
wrangler kv:namespace create RATE_LIMITS
wrangler kv:namespace create CLAIMS
```

Update `wrangler.toml` with the returned namespace IDs.

### 4. Configure Cloudflare Turnstile

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) > Turnstile
2. Create a new widget for `faucet.knexcoins.com`
3. Get your Site Key and Secret Key
4. Update `TURNSTILE_SITE_KEY` in `wrangler.toml`

### 5. Set Secrets

```bash
wrangler secret put TURNSTILE_SECRET
# Paste your Turnstile secret key

# Optional - for production mode:
wrangler secret put FAUCET_PRIVATE_KEY
# Paste the faucet wallet's Ed25519 private key (hex)

wrangler secret put FAUCET_ADDRESS
# Paste the faucet wallet's public address (K...)

wrangler secret put NODE_RPC_URL
# E.g., https://testnet.knexcoin.com:7076
```

### 6. Deploy

```bash
# Test locally
npm run dev

# Deploy to production
npm run deploy
```

### 7. Configure DNS

Add a Workers Route in Cloudflare Dashboard, or use the route in `wrangler.toml`:

```toml
routes = [
  { pattern = "faucet.knexcoins.com/*", zone_name = "knexcoins.com" }
]
```

## API Endpoints

### POST /api/faucet

Claim testnet KNEX.

**Request:**
```json
{
  "address": "KABC2DEF3GHI4JKL5MNO6PQR7STU2VWX3YZ4ABC5DEF6GHI7JKL",
  "turnstile_token": "turnstile_response_token"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "tx_hash": "abc123...",
  "amount": "100",
  "message": "Successfully sent 100 KNEX to K...",
  "next_claim_at": "2026-02-02T14:00:00.000Z"
}
```

**Error Response (429):**
```json
{
  "error": "Already claimed today",
  "details": "Please wait 18 hours before claiming again",
  "next_claim_at": "2026-02-02T14:00:00.000Z"
}
```

### GET /api/status

Get faucet status and balance.

**Response:**
```json
{
  "status": "online",
  "faucet_address": "K...",
  "balance": "4,500,000 KNEX",
  "claim_amount": "100 KNEX",
  "rate_limits": {
    "per_address": "1 claim per 24 hours",
    "per_ip": "10 claims per hour"
  }
}
```

### GET /api/pow-challenge

Get a PoW challenge (optional client-side computation).

**Response:**
```json
{
  "challenge": "a1b2c3...",
  "difficulty": 4,
  "message": "Find nonce where blake2b(challenge + nonce) starts with 4 zeros"
}
```

## Test Mode

When `NODE_RPC_URL`, `FAUCET_ADDRESS`, or `FAUCET_PRIVATE_KEY` are not configured, the faucet runs in test mode:
- Generates mock transaction hashes
- Useful for UI development and testing
- Rate limiting still works

## Faucet Wallet Setup

Create a dedicated faucet wallet:

```bash
# Using the KnexCoin wallet or keygen tool
# Generate a new Ed25519 keypair
# Fund it with testnet allocation (5,000,000 KNEX recommended)
```

## Monitoring

Check faucet status:
```bash
curl https://faucet.knexcoins.com/api/status
```

View worker logs:
```bash
npm run tail
# or
wrangler tail
```

## Configuration

Edit `wrangler.toml` to adjust:

| Variable | Default | Description |
|----------|---------|-------------|
| `FAUCET_AMOUNT` | 10000 | Display amount (100 KNEX) |
| `DAILY_LIMIT_PER_ADDRESS` | 1 | Claims per address per day |
| `HOURLY_LIMIT_PER_IP` | 10 | Claims per IP per hour |
| `TURNSTILE_SITE_KEY` | - | Cloudflare Turnstile site key |

## Security Considerations

1. **Private Key Storage**: Stored as Cloudflare secret (encrypted at rest)
2. **Rate Limiting**: Dual rate limiting (address + IP) prevents abuse
3. **Turnstile**: Cloudflare's invisible CAPTCHA blocks bots
4. **Address Validation**: Strict regex validation prevents malformed requests
5. **CORS**: Configured for cross-origin requests

## Troubleshooting

**"Turnstile verification failed" error:**
- Ensure site key matches your domain in Cloudflare Dashboard
- Check that the secret key is correctly set via `wrangler secret`

**"Faucet transaction failed" error:**
- Verify `NODE_RPC_URL` is accessible from Cloudflare
- Check faucet wallet balance
- Ensure private key format is correct (hex-encoded)
- If no node configured, faucet runs in test mode

**Rate limit not resetting:**
- KV TTL is 24 hours for addresses, 1 hour for IPs
- Wait for TTL to expire or clear KV manually in dashboard

## License

MIT License - see [LICENSE](LICENSE)

## Links

- [KnexCoin Website](https://knexcoins.com)
- [Whitepaper](https://knexcoins.com/whitepaper.html)
- [GitHub](https://github.com/knexcoin)
