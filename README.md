# Plurality Backend API

Backend API to support dashboard and widget workflows

## How to run

1. Install dependencies

```
npm install
```

2. Run

```
npm run start
```
## Run Stripe CLI
```
stripe login
stripe listen --forward-to http://localhost:5000/subscription/webhook --skip-verify
```
