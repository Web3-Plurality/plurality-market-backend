import { Response } from 'express';

// Distinct from memory-studio's 'auth_token': on localhost dev both apps
// share the cookie jar (ports don't isolate cookies), so an identical name
// meant logging into one product silently logged you out of the other —
// the marketplace then 403'd every call with the studio-signed JWT.
const COOKIE_NAME = 'market_auth_token';
const isProduction = process.env.NODE_ENV === 'production';

// Cookie options for HttpOnly JWT
const cookieOptions = {
  httpOnly: true, // Not accessible via JavaScript
  secure: isProduction, // HTTPS only in production
  sameSite: 'strict' as const, // CSRF protection
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
  path: '/',
};

/**
 * Set the JWT token as an HttpOnly cookie
 */
export const setAuthCookie = (res: Response, token: string): void => {
  res.cookie(COOKIE_NAME, token, cookieOptions);
};

/**
 * Clear the auth cookie (for logout)
 */
export const clearAuthCookie = (res: Response): void => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
  });
};

export { COOKIE_NAME };
