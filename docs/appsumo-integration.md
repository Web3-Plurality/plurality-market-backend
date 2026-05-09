# AppSumo Integration

## Overview

This document describes the AppSumo lifetime deal integration — how licenses are created, linked to users, upgraded/downgraded, and revoked.

**Source file:** `src/services/subscription-service/controllers/appsumo-controller.ts`

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `APPSUMO_API_KEY` | Secret used to verify HMAC webhook signatures |
| `APPSUMO_CLIENT_ID` | OAuth client ID from AppSumo dashboard |
| `APPSUMO_CLIENT_SECRET` | OAuth client secret from AppSumo dashboard |
| `APPSUMO_REDIRECT_URI` | OAuth callback URL registered with AppSumo |
| `APPSUMO_SUCCESS_URL` | Where to redirect the user after successful activation |
| `APPSUMO_ERROR_URL` | Where to redirect the user on activation failure |
| `APPSUMO_LOGIN_URL` | Where to redirect unauthenticated users (default: `/login`) |
| `FRONTEND_URL` | Frontend app URL for page redirects (default: `http://localhost:3000`) |

---

## Tier to Plan Mapping

| AppSumo Tier | Plan Name | Credits/day | Context Storage | Price |
|---|---|---|---|---|
| 1 | `APPSUMO_TIER_1` | 100 | 1 GB | $59 |
| 2 | `APPSUMO_TIER_2` | 300 | 5 GB | $149 |
| 3 | `APPSUMO_TIER_3` | 1,000 | 10 GB | $339 |

AppSumo plans are lifetime deals (`durationInMonths: 0`, `expiresAt: null`) and are hidden from the regular plans list (`isActive: false` in `plans.ts`).

---

## Integration Flow

### Phase 1 — License Created via Webhook

AppSumo calls `POST /appsumo/webhook` automatically when a user purchases or changes a license. No user interaction is required at this stage.

```
AppSumo Server
    │
    ▼
POST /appsumo/webhook
    │
    ├── 1. Verify HMAC-SHA256 signature
    │       message  = timestamp + rawBody  (direct concatenation, no separator)
    │       expected = HMAC-SHA256(message, APPSUMO_API_KEY)
    │       compare  = timingSafeEqual(expected, received)
    │
    ├── 2. Parse JSON body → event type
    │
    └── 3. Handle event (see table below)
```

**Webhook Events**

| Event | Action |
|---|---|
| `purchase` | Upsert `AppSumoLicense` with `status: INACTIVE`, `userId: null` |
| `activate` | Upsert `AppSumoLicense` with `status: ACTIVE`, `userId: null` |
| `upgrade` / `downgrade` | Find old license by `prev_license_key`, replace `licenseKey` with new UUID, update `tier`. If a user is already linked, update their `UserSubscription` plan and credits immediately |
| `deactivate` | Mark license `DEACTIVATED`. If the reason is a refund (not an upgrade/downgrade side-effect), downgrade user to `FREE` plan |
| `migrate` / unknown | Log and ignore — no action taken |

> The webhook handler always returns `HTTP 200` even on internal errors to prevent AppSumo from retrying indefinitely. Errors are logged with full details.

---

### Phase 2 — User Links Their License via OAuth

After purchasing on AppSumo, the user clicks **"Activate"** which redirects them to your OAuth callback URL. If the user is not logged in, they are redirected to the frontend activation page with the license key in the URL.

```
User clicks "Activate" on AppSumo
    │
    ▼
GET /appsumo/oauth/callback?code=<authorization_code>
    │
    ├── No ?code param?
    │       └── Return HTTP 200 { ok: true }
    │           (AppSumo validation ping — happens when you register the redirect URL)
    │
    ├── 1. Read JWT from cookie (COOKIE_NAME) or Authorization header
    │       └── Invalid / missing → redirect to APPSUMO_ERROR_URL?error=unauthenticated
    │
    ├── 2. Exchange ?code for access_token
    │       POST https://appsumo.com/openid/token/
    │           client_id, client_secret, redirect_uri, code, grant_type
    │       └── No access_token → redirect to APPSUMO_ERROR_URL?error=token_exchange_failed
    │
    ├── 3. Fetch license key
    │       GET https://appsumo.com/openid/license_key/?access_token=<token>
    │       └── No license_key → redirect to APPSUMO_ERROR_URL?error=license_fetch_failed
    │
    ├── 4. Find license in DB
    │       └── Not found → create stub (webhook may arrive later)
    │
    ├── 5. Guard checks
    │       ├── License claimed by a DIFFERENT user
    │       │       └── redirect to APPSUMO_ERROR_URL?error=license_already_claimed
    │       └── License already linked to THIS user
    │               └── redirect to APPSUMO_SUCCESS_URL?already_active=true  (idempotent)
    │
    ├── 6. applyLicenseToUser(license, userId)
    │
    └── 7. redirect to APPSUMO_SUCCESS_URL
```

#### `applyLicenseToUser` — Internal Steps

```
applyLicenseToUser(license, userId)
    │
    ├── 1. Map tier → plan name (APPSUMO_TIER_1 / _2 / _3)
    │
    ├── 2. getOrCreateUserSubscription(userId)
    │
    ├── 3. Cancel existing Stripe subscription (best-effort, non-fatal)
    │       stripe.subscriptions.cancel(stripeSubscriptionId)
    │
    ├── 4. Update UserSubscription
    │       planType          = APPSUMO_TIER_X
    │       creditsRemaining  = plan.credits
    │       creditsUsed       = 0
    │       expiresAt         = null  ← lifetime deal, no expiry
    │       lastResetAt       = now
    │       stripeSubscriptionId = null
    │
    ├── 5. Create PaymentTransaction
    │       status   = COMPLETED
    │       amount   = tier price (59 / 149 / 339 USD)
    │       invoiceId = license.licenseKey
    │       metadata  = { source: 'appsumo', licenseKey, tier }
    │
    └── 6. Update AppSumoLicense
            userId      = userId
            status      = ACTIVE
            activatedAt = now
```

---

### Phase 3 — Upgrade / Downgrade

AppSumo sends an `upgrade` or `downgrade` webhook when a user changes their tier. A new `license_key` UUID is issued for every tier change.

```
AppSumo → POST /appsumo/webhook  { event: "upgrade", prev_license_key, license_key, tier }
    │
    ├── Find existing license by prev_license_key
    │       └── Not found → log warning, stop
    │
    ├── Replace licenseKey with new UUID
    ├── Update tier and status = ACTIVE
    │
    └── If license.userId is set (user already activated):
            └── Update UserSubscription
                    planType         = new APPSUMO_TIER_X
                    creditsRemaining = new plan credits
                    creditsUsed      = 0
                    expiresAt        = null
                    lastResetAt      = now
```

> AppSumo also sends a `deactivate` event for the old license key during tier changes. The deactivate handler checks the reason to avoid incorrectly downgrading the user to FREE.

---

### Phase 4 — Deactivation / Refund

```
AppSumo → POST /appsumo/webhook  { event: "deactivate", license_key, extra: { reason } }
    │
    ├── Find license by licenseKey
    │       └── Not found → log warning, stop
    │
    ├── Set license.status = DEACTIVATED, deactivatedAt = now
    │
    └── Determine if this is a real refund:
            isRefund = reason does NOT contain "upgrad" or "downgrad"
            │
            ├── isRefund = true AND license.userId set:
            │       └── Downgrade UserSubscription to FREE plan
            │
            └── isRefund = false:
                    └── Skip downgrade (tier-change side-effect)
```

---

### Phase 5 — Status Check (Frontend)

```
GET /appsumo/status   (requires authentication)
    │
    └── Response:
            { hasAppSumoLicense: false }                    ← no license found
            { hasAppSumoLicense: true, tier, status, planName, activatedAt }
```

> `hasAppSumoLicense: true` is returned even if `status` is `DEACTIVATED`. The frontend must check `status === 'ACTIVE'` to determine if the license is currently valid.

---

## Routes Summary

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/appsumo/webhook` | None (HMAC signature) | Receive AppSumo lifecycle events |
| `GET` | `/appsumo/oauth/callback` | JWT cookie / header | Exchange OAuth code and link license to user |
| `POST` | `/appsumo/activate` | `isAuthenticated` middleware | Link a license key to the authenticated user |
| `GET` | `/appsumo/status` | `isAuthenticated` middleware | Get AppSumo license status for current user |

---

## Database Entities

### `appsumo_license`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | Primary key |
| `licenseKey` | varchar(255) | Unique; replaced on every upgrade/downgrade |
| `userId` | UUID (nullable) | Set after OAuth activation |
| `tier` | integer | 1, 2, or 3 |
| `status` | enum | `INACTIVE` / `ACTIVE` / `DEACTIVATED` |
| `invoiceItemUuid` | varchar(255) | AppSumo invoice reference |
| `activatedAt` | timestamp | When `applyLicenseToUser` ran |
| `deactivatedAt` | timestamp | When deactivate webhook was processed |

---

## Known Issues / Caveats

### 1. Deactivate reason detection is fragile
The code distinguishes refunds from tier-change deactivations by substring-matching the `extra.reason` field:

```ts
const isRefund = !reason.includes('upgrad') && !reason.includes('downgrad');
```

If AppSumo sends an empty or unexpected string in `extra.reason` during an upgrade/downgrade, `isRefund` will be `true` and the user will be incorrectly downgraded to FREE. Verify what AppSumo sends in this field and consider using an explicit allowlist of refund reason values instead.

### 2. Tier defaults to 1 when webhook arrives after OAuth
If the user goes through OAuth before the `purchase`/`activate` webhook arrives, the code creates a license stub with:

```ts
const tier = Number(licenseResponse.data.tier ?? 1);
```

AppSumo's `license_key` endpoint may not return `tier`. In that case the user is activated on Tier 1 regardless of what they purchased. The webhook will not re-apply the license once a `userId` is already set.

### 3. `invoiceItemUuid` not updated on upgrade/downgrade
The upgrade/downgrade handler replaces `licenseKey` and `tier` but does not update `invoiceItemUuid`. The stored invoice will reference the original purchase, not the new tier's invoice.

### 4. `hasAppSumoLicense: true` for deactivated licenses
The `/status` endpoint returns `hasAppSumoLicense: true` for users with a `DEACTIVATED` license. Always check the `status` field before treating the license as active.
