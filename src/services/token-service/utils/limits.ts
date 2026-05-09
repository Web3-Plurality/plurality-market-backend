// Soft-unlimited ceiling on active (non-revoked, non-expired) PATs per paid user.
// Set high enough that real users won't hit it; exists purely as an abuse guard against
// scripted mass-create. Free-plan users are not eligible for PATs (gated via isPaidPlan).
export const PAT_LIMIT_PAID = 100;
