import { Response } from 'express';

const COOKIE_NAME = 'auth_token';
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
