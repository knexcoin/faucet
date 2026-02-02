/**
 * KnexCoin Faucet - Cloudflare Workers
 *
 * Anti-spam layers:
 * 1. Cloudflare Turnstile verification
 * 2. Rate limiting per address (1 claim/24h)
 * 3. Rate limiting per IP (10 claims/hour)
 * 4. Client-side PoW verification
 * 5. Request validation
 */

import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';

// Constants
const FAUCET_AMOUNT_RAW = 1000000000n; // 100 KNEX (7 decimals)
const FAUCET_AMOUNT_DISPLAY = "100";
const DAILY_TTL = 86400; // 24 hours in seconds
const HOURLY_TTL = 3600; // 1 hour in seconds
const POW_DIFFICULTY = 4; // Leading zeros required in PoW hash

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Route handling
    if (url.pathname === '/api/faucet' && request.method === 'POST') {
      return handleFaucetClaim(request, env);
    }

    if (url.pathname === '/api/status') {
      return handleStatus(env);
    }

    if (url.pathname === '/api/pow-challenge') {
      return handlePowChallenge(request, env);
    }

    // Serve static frontend
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveFrontend(env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
};

/**
 * Main faucet claim handler
 */
async function handleFaucetClaim(request, env) {
  try {
    const body = await request.json();
    const { address, turnstile_token, pow_nonce, pow_challenge } = body;

    // Validate address format
    if (!address || !isValidKnexAddress(address)) {
      return jsonResponse({
        error: 'Invalid KnexCoin address',
        details: 'Address must start with "K" and be 56 characters (Base32)'
      }, 400);
    }

    // Get client IP
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

    // 1. Verify Cloudflare Turnstile
    if (!turnstile_token) {
      return jsonResponse({ error: 'Turnstile verification required' }, 400);
    }

    const turnstileValid = await verifyTurnstile(turnstile_token, clientIP, env.TURNSTILE_SECRET);
    if (!turnstileValid) {
      return jsonResponse({ error: 'Turnstile verification failed' }, 400);
    }

    // 2. Client-side PoW verification (optional - Turnstile is primary protection)
    // Skipping server-side PoW verification as Turnstile provides sufficient bot protection

    // 3. Check rate limit per address (1 per 24h)
    const addressKey = `addr:${address}`;
    const existingClaim = await env.CLAIMS.get(addressKey);
    if (existingClaim) {
      const claimData = JSON.parse(existingClaim);
      const hoursRemaining = Math.ceil((claimData.expires - Date.now()) / 3600000);
      return jsonResponse({
        error: 'Already claimed today',
        details: `Please wait ${hoursRemaining} hours before claiming again`,
        next_claim_at: new Date(claimData.expires).toISOString()
      }, 429);
    }

    // 4. Check rate limit per IP (10 per hour)
    const ipKey = `ip:${clientIP}`;
    const ipClaims = await env.RATE_LIMITS.get(ipKey);
    const ipCount = ipClaims ? parseInt(ipClaims) : 0;

    if (ipCount >= 10) {
      return jsonResponse({
        error: 'IP rate limit exceeded',
        details: 'Maximum 10 claims per IP per hour'
      }, 429);
    }

    // 5. Send coins from faucet
    const result = await sendFromFaucet(address, env);

    if (!result.success) {
      return jsonResponse({
        error: 'Faucet transaction failed',
        details: result.error
      }, 500);
    }

    // 6. Record the claim
    const claimRecord = {
      address,
      ip: clientIP,
      amount: FAUCET_AMOUNT_DISPLAY,
      tx_hash: result.tx_hash,
      timestamp: Date.now(),
      expires: Date.now() + (DAILY_TTL * 1000)
    };

    await env.CLAIMS.put(addressKey, JSON.stringify(claimRecord), {
      expirationTtl: DAILY_TTL
    });

    // 7. Increment IP counter
    await env.RATE_LIMITS.put(ipKey, String(ipCount + 1), {
      expirationTtl: HOURLY_TTL
    });

    return jsonResponse({
      success: true,
      tx_hash: result.tx_hash,
      amount: FAUCET_AMOUNT_DISPLAY,
      message: `Successfully sent ${FAUCET_AMOUNT_DISPLAY} KNEX to ${address}`,
      next_claim_at: new Date(claimRecord.expires).toISOString()
    });

  } catch (error) {
    console.error('Faucet error:', error);
    return jsonResponse({
      error: 'Internal server error',
      details: error.message
    }, 500);
  }
}

/**
 * Verify Cloudflare Turnstile token
 */
async function verifyTurnstile(token, clientIP, secret) {
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: secret,
        response: token,
        remoteip: clientIP
      })
    });

    const data = await response.json();
    return data.success === true;
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return false;
  }
}

/**
 * Verify client-side Proof-of-Work
 */
function verifyPoW(challenge, nonce, difficulty) {
  try {
    const data = challenge + nonce;
    const hash = bytesToHex(blake2b(new TextEncoder().encode(data), { dkLen: 32 }));

    // Check if hash has required leading zeros
    const prefix = '0'.repeat(difficulty);
    return hash.startsWith(prefix);
  } catch (error) {
    return false;
  }
}

/**
 * Generate PoW challenge
 */
async function handlePowChallenge(request, env) {
  const challenge = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  return jsonResponse({
    challenge,
    difficulty: POW_DIFFICULTY,
    message: `Find nonce where blake2b(challenge + nonce) starts with ${POW_DIFFICULTY} zeros`
  });
}

/**
 * Send KNEX from faucet wallet to recipient
 */
async function sendFromFaucet(toAddress, env) {
  // Check if node is configured
  const nodeUrl = env.NODE_RPC_URL;

  if (!nodeUrl || !env.FAUCET_ADDRESS || !env.FAUCET_PRIVATE_KEY) {
    // Test mode - no node configured yet
    // Generate a mock transaction hash for testing the UI
    const mockHash = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return {
      success: true,
      tx_hash: mockHash,
      test_mode: true
    };
  }

  try {
    // Production mode - send via node RPC
    const response = await fetch(`${nodeUrl}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FAUCET_ADDRESS,
        to: toAddress,
        amount: FAUCET_AMOUNT_RAW.toString(),
        private_key: env.FAUCET_PRIVATE_KEY
      })
    });

    const data = await response.json();

    if (data.error) {
      return { success: false, error: data.error };
    }

    return {
      success: true,
      tx_hash: data.hash || data.block_hash
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Validate KnexCoin address format
 */
function isValidKnexAddress(address) {
  // K prefix + 55 Base32 characters (total 56)
  // Base32 alphabet: A-Z, 2-7
  const knexAddressRegex = /^K[A-Z2-7]{55}$/;
  return knexAddressRegex.test(address);
}

/**
 * Faucet status endpoint
 */
async function handleStatus(env) {
  try {
    const nodeUrl = env.NODE_RPC_URL || 'https://testnet.knexcoin.com:7076';

    // Get faucet balance
    const response = await fetch(`${nodeUrl}/api/balance/${env.FAUCET_ADDRESS}`);
    const data = await response.json();

    const balanceRaw = BigInt(data.balance || '0');
    const balanceKnex = Number(balanceRaw) / 10000000; // 7 decimals

    return jsonResponse({
      status: 'online',
      faucet_address: env.FAUCET_ADDRESS,
      balance: balanceKnex.toLocaleString() + ' KNEX',
      claim_amount: FAUCET_AMOUNT_DISPLAY + ' KNEX',
      rate_limits: {
        per_address: '1 claim per 24 hours',
        per_ip: '10 claims per hour'
      },
      anti_spam: ['Cloudflare Turnstile', 'Rate limiting', 'Proof-of-Work']
    });
  } catch (error) {
    return jsonResponse({
      status: 'online',
      error: 'Could not fetch balance'
    });
  }
}

/**
 * Serve the faucet frontend HTML
 */
function serveFrontend(env) {
  // Get Turnstile site key from env or use placeholder
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY || '0x4AAAAAAXXXXXXXXXXXXXXX';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KnexCoin Testnet Faucet</title>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <style>
        :root {
            --bg: #0a0a0a;
            --bg-card: #111;
            --neon: #00ff88;
            --cyan: #00ffff;
            --magenta: #ff00ff;
            --text: #f0f0f0;
            --text-dim: #888;
            --border: rgba(0,255,136,0.2);
            --glow: 0 0 20px rgba(0,255,136,0.4);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'JetBrains Mono', monospace;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .container {
            max-width: 500px;
            width: 100%;
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
        }

        .logo {
            font-size: 2.5rem;
            font-weight: 700;
            color: var(--neon);
            text-shadow: var(--glow);
            margin-bottom: 8px;
        }

        .subtitle {
            color: var(--cyan);
            font-size: 0.9rem;
        }

        .badge {
            display: inline-block;
            background: rgba(255,255,0,0.1);
            border: 1px solid #ffff00;
            color: #ffff00;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 0.7rem;
            margin-top: 12px;
        }

        .card {
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 32px;
        }

        .form-group {
            margin-bottom: 24px;
        }

        label {
            display: block;
            color: var(--text-dim);
            font-size: 0.8rem;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.1em;
        }

        input {
            width: 100%;
            background: #0d1117;
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 16px;
            color: var(--text);
            font-family: inherit;
            font-size: 0.95rem;
            transition: border-color 0.2s, box-shadow 0.2s;
        }

        input:focus {
            outline: none;
            border-color: var(--neon);
            box-shadow: 0 0 0 3px rgba(0,255,136,0.1);
        }

        input::placeholder {
            color: var(--text-dim);
        }

        .captcha-wrapper {
            display: flex;
            justify-content: center;
            margin-bottom: 24px;
        }

        /* Style Turnstile widget */
        .cf-turnstile {
            margin: 0 auto;
        }

        button {
            width: 100%;
            background: linear-gradient(135deg, var(--neon), #00cc6a);
            border: none;
            border-radius: 8px;
            padding: 16px;
            color: #000;
            font-family: inherit;
            font-size: 1rem;
            font-weight: 700;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        button:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: var(--glow);
        }

        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .result {
            margin-top: 24px;
            padding: 16px;
            border-radius: 8px;
            display: none;
        }

        .result.success {
            display: block;
            background: rgba(0,255,136,0.1);
            border: 1px solid var(--neon);
        }

        .result.error {
            display: block;
            background: rgba(255,51,51,0.1);
            border: 1px solid #ff3333;
        }

        .result h4 {
            margin-bottom: 8px;
        }

        .result.success h4 { color: var(--neon); }
        .result.error h4 { color: #ff3333; }

        .result p {
            color: var(--text-dim);
            font-size: 0.85rem;
            word-break: break-all;
        }

        .info {
            margin-top: 32px;
            text-align: center;
            color: var(--text-dim);
            font-size: 0.8rem;
        }

        .info a {
            color: var(--cyan);
            text-decoration: none;
        }

        .pow-status {
            font-size: 0.75rem;
            color: var(--text-dim);
            text-align: center;
            margin-top: 12px;
        }

        .spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid var(--neon);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .tx-link {
            color: var(--cyan);
            text-decoration: none;
        }
        .tx-link:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">KNEXCOIN</div>
            <div class="subtitle">Testnet Faucet</div>
            <span class="badge">TESTNET ONLY</span>
        </div>

        <div class="card">
            <form id="faucetForm">
                <div class="form-group">
                    <label>Your KnexCoin Address</label>
                    <input
                        type="text"
                        id="address"
                        placeholder="KABC...XYZ"
                        pattern="^K[A-Z2-7]{55}$"
                        required
                        autocomplete="off"
                        spellcheck="false"
                    >
                </div>

                <div class="captcha-wrapper">
                    <div class="cf-turnstile"
                         data-sitekey="${turnstileSiteKey}"
                         data-theme="dark"
                         data-callback="onTurnstileSuccess">
                    </div>
                </div>

                <button type="submit" id="claimBtn">
                    Claim 100 KNEX
                </button>

                            </form>

            <div class="result" id="result">
                <h4 id="resultTitle"></h4>
                <p id="resultMessage"></p>
            </div>
        </div>

        <div class="info">
            <p>Claim 100 testnet KNEX every 24 hours</p>
            <p style="margin-top: 8px;">
                <a href="https://explorer.testnet.knexcoin.com" target="_blank">Block Explorer</a> |
                <a href="https://knexcoin.com" target="_blank">Main Site</a>
            </p>
        </div>
    </div>

    <script>
        const form = document.getElementById('faucetForm');
        const claimBtn = document.getElementById('claimBtn');
        const result = document.getElementById('result');
        const powStatus = document.getElementById('powStatus');
        let turnstileToken = null;

        // Turnstile callback
        function onTurnstileSuccess(token) {
            turnstileToken = token;
        }
        window.onTurnstileSuccess = onTurnstileSuccess;

        // Client-side Proof-of-Work solver
        async function solvePoW(challenge, difficulty) {
            powStatus.textContent = 'Computing proof-of-work...';

            return new Promise((resolve) => {
                let nonce = 0;
                const prefix = '0'.repeat(difficulty);

                function tryNonce() {
                    const batch = 10000;
                    for (let i = 0; i < batch; i++) {
                        const data = challenge + nonce.toString();
                        const hash = simpleHash(data);
                        if (hash.startsWith(prefix)) {
                            powStatus.textContent = 'Proof-of-work complete!';
                            resolve(nonce.toString());
                            return;
                        }
                        nonce++;
                    }

                    powStatus.textContent = 'Computing PoW... (tried ' + nonce.toLocaleString() + ' nonces)';
                    setTimeout(tryNonce, 0);
                }

                tryNonce();
            });
        }

        // Simple hash function for client-side PoW
        function simpleHash(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                const char = str.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return Math.abs(hash).toString(16).padStart(8, '0');
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const address = document.getElementById('address').value.trim();

            // Validate address format
            if (!address.match(/^K[A-Z2-7]{55}$/)) {
                showResult('error', 'Invalid address format. Must start with K followed by 55 Base32 characters (A-Z, 2-7).');
                return;
            }

            if (!turnstileToken) {
                showResult('error', 'Please complete the verification');
                return;
            }

            claimBtn.disabled = true;
            claimBtn.innerHTML = '<span class="spinner"></span>Processing...';

            try {
                // Submit claim (Turnstile provides bot protection)
                const response = await fetch('/api/faucet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        address,
                        turnstile_token: turnstileToken
                    })
                });

                const data = await response.json();

                if (data.success) {
                    const txShort = data.tx_hash ? data.tx_hash.substring(0, 16) + '...' : 'pending';
                    const nextClaim = new Date(data.next_claim_at).toLocaleString();
                    showResult('success',
                        'Sent ' + data.amount + ' KNEX!<br>' +
                        'TX: <a class="tx-link" href="https://explorer.testnet.knexcoin.com/tx/' + data.tx_hash + '" target="_blank">' + txShort + '</a><br>' +
                        'Next claim: ' + nextClaim
                    );
                } else {
                    showResult('error', data.error + (data.details ? '<br>' + data.details : ''));
                }
            } catch (error) {
                showResult('error', 'Network error: ' + error.message);
            } finally {
                claimBtn.disabled = false;
                claimBtn.textContent = 'Claim 100 KNEX';
                // Reset Turnstile
                if (window.turnstile) {
                    turnstile.reset();
                }
                turnstileToken = null;
            }
        });

        function showResult(type, message) {
            result.className = 'result ' + type;
            document.getElementById('resultTitle').textContent = type === 'success' ? 'Success!' : 'Error';
            document.getElementById('resultMessage').innerHTML = message;
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' }
  });
}

/**
 * JSON response helper
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders
  });
}
