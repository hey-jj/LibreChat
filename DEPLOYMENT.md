# Deployment Notes

This repository contains the LibreChat application source.

The canonical production deployment runbook for the HeyJones GCP environment lives in the sibling private repository:

- `../librechat-gcp-deployment/DEPLOYMENT_RUNBOOK.md`
- `../librechat-gcp-deployment/README.md`

## Production Topology

- Canonical user-facing hostname: `https://chat.heysynaptic.com`
- Frontend static hosting: Firebase Hosting site `librechat-production`
- Main API: Cloud Run service `librechat-api` in `us-west3`
- Load balancer: `librechat-http-lb`
- Path routing: `/api/*` and `/images/*` go to the API backend service, all other routes go to Firebase Hosting

Do not use `https://librechat-production.web.app` as the primary verification URL for login or app bootstrap checks. It is not the canonical app origin, and same-origin `/api/*` requests are not routed there the same way they are on `https://chat.heysynaptic.com`.

## Ownership Boundary

- Application code and frontend build output come from this repository.
- Production GCP deploy scripts, runtime config, and Cloud Run release flow live in `../librechat-gcp-deployment`.

## Frontend Release Reminder

When verifying a frontend-only change, validate the deployed bundle against:

- `https://chat.heysynaptic.com/login`

Follow the private runbook for the exact Firebase Hosting deploy command and backend release procedure.
