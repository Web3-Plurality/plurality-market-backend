import stytch, { OTPsAuthenticateRequest, OTPsEmailLoginOrCreateRequest } from 'stytch';
import express, { Request, Response } from 'express';
import axios from 'axios';
import Logger from '../../../lib/logger';
import { AppDataSource } from '../../../data-source';
import { LoginType, User } from '../../user-service/entity/user';
import jwt from 'jsonwebtoken';
import { AddUserSession, ensureChatEncKey } from '../utils/user';
import { addMailchimpSubscriber } from '../utils/mailchimp';
import { setAuthCookie, clearAuthCookie, COOKIE_NAME } from '../utils/cookie';
import { isAuthenticated, optionalAuthentication } from '../../user-service/middlewares/auth-middleware';
import * as dotenv from 'dotenv';
import { userOperations, authAttempts } from '../../../lib/metrics';

dotenv.config();
export const authOTPRouter = express.Router();
const userRepository = AppDataSource.getRepository(User);

const stytchClient = new stytch.Client({
  project_id: process.env.STYTCH_PROJECT_ID || '',
  secret: process.env.STYTCH_SECRET || '',
});

const templateId = process.env.USER_OTP_TEMPLATE_ID || '';

// Start the authentication flow
authOTPRouter.post('/login', async function (req: Request, res: Response) {
  // #swagger.tags = ['Auth']
  try {
    const email: string = req.body.email;

    // Validate email is provided
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Validate email is a string
    if (typeof email !== 'string') {
      return res.status(400).json({ error: 'Email must be a string' });
    }

    // // Validate email format
    // const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    // if (!emailRegex.test(email)) {
    //   return res.status(400).json({ error: 'Invalid email format' });
    // }

    // // Validate email length
    // if (email.length > 255) {
    //   return res.status(400).json({ error: 'Email is too long. Maximum length is 255 characters.' });
    // }

    const options: OTPsEmailLoginOrCreateRequest = {
      email: email.trim().toLowerCase(),
      login_template_id: templateId,
      expiration_minutes: 2,
    };

    const existingUser = await userRepository.findOne({
      where: {
        email: email.trim().toLowerCase(),
      },
    });
    if (existingUser && !existingUser.loginType) {
      Logger.info(`user ${existingUser.id} does not have login type, updating login type to stytch`);
      await userRepository.update(existingUser.id, { loginType: LoginType.stytch });
    }

    const resp = await stytchClient.otps.email.loginOrCreate(options);
    Logger.info('OTP sent successfully');
    res.status(200).json({ success: true, message: 'OTP sent successfully', emailId: resp?.email_id });
  } catch (err) {
    console.error(err);
    res.status(400).send('Authentication failed');
  }
});

// Complete the authentication flow which mints the session
// parameters : code, email_id, address, subscribe, clientAppId
authOTPRouter.post('/authenticate', async function (req: Request, res: Response) {
  // #swagger.tags = ['Auth']
  try {
    let addedUser: User = new User();
    /* eslint-disable */
    const { code, email_id, subscribe } = req.body;

    // Validate code
    if (!code) {
      return res.status(400).json({ error: 'OTP code is required' });
    }

    if (typeof code !== 'string') {
      return res.status(400).json({ error: 'OTP code must be a string' });
    }

    if (code.length > 10) {
      return res.status(400).json({ error: 'OTP code is too long' });
    }

    // Validate email_id
    if (!email_id) {
      return res.status(400).json({ error: 'Email ID is required' });
    }

    if (typeof email_id !== 'string') {
      return res.status(400).json({ error: 'Email ID must be a string' });
    }

    // Validate subscribe if provided
    if (subscribe !== undefined && typeof subscribe !== 'boolean') {
      return res.status(400).json({ error: 'Subscribe must be a boolean' });
    }

    const params: OTPsAuthenticateRequest = {
      code: code,
      session_duration_minutes: 60,
      method_id: email_id,
    };
    /* eslint-enable */

    // stytch authenticate
    const resp = await stytchClient.otps.authenticate(params);
    Logger.info('stytch Authenticated successfully');
    // Check if the user with the given email already exists (case-insensitive)
    const email = resp?.user?.emails[0]?.email?.trim().toLowerCase();
    const existingUser = await userRepository
      .createQueryBuilder('u')
      .where('LOWER(u.email) = :email', { email })
      .getOne();
    if (existingUser) {
      Logger.info(`This user already exists!`);
      // Upgrade stub user if needed (created via sharing before sign-up)
      if (!existingUser.loginType || existingUser.loginType === '') {
        existingUser.loginType = LoginType.stytch;
        await userRepository.save(existingUser);
        Logger.info(`[OTP] Upgraded stub user ${existingUser.id} to stytch login`);
      }
      // Track existing user login
      authAttempts.inc({ method: 'otp', status: 'success' });
    } else {
      // If the user doesn't exist, insert a new row
      Logger.info(`The user with this email was not found`);
      const newUser = await userRepository.create({
        email: email,
        subscribe: req?.body?.subscribe,
        loginType: LoginType.stytch,
      });
      addedUser = await userRepository.save(newUser);
      Logger.info(`new user created successfully with id ${addedUser?.id}`);

      // Track new user sign-up
      userOperations.inc({ operation: 'signup', status: 'success' });
      authAttempts.inc({ method: 'otp', status: 'success' });

      // Add to Mailchimp (fire-and-forget)
      addMailchimpSubscriber(email);
    }

    const userId = existingUser?.id ? existingUser?.id : addedUser?.id;
    const uniqueSessionId = await AddUserSession(userId);
    const chatEncKey = await ensureChatEncKey(userId);
    Logger.info(`jwt token generated for user id ${userId}`);
    const token = jwt.sign({ id: userId, uniqueSessionId }, process.env.JWT_SECRET || '', {
      expiresIn: process.env.JWT_EXPIRY,
    });

    // Set JWT as HttpOnly cookie (primary auth for web app)
    setAuthCookie(res, token);

    return res.status(200).json({
      success: true,
      token: token, // Still returned for extension compatibility
      stytchToken: resp?.session_jwt,
      user: existingUser?.id ? existingUser : addedUser,
      userId: resp?.user_id,
      chatEncKey,
    });
  } catch (err) {
    console.error(err);
    // Track failed authentication attempt
    authAttempts.inc({ method: 'otp', status: 'error' });
    res.status(401).send('Authentication failed');
  }
});

// Retrieve session key (chatEncKey) for authenticated user
// Used by browser extension to recover encryption key after browser restart
// Also returns the JWT token so the frontend can sync it with the extension
authOTPRouter.get('/session-key', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Auth']
  /* #swagger.security = [{ "bearerAuth": [] }] */
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'User not found in token' });
    }

    // Get the raw JWT token from cookie or Authorization header (same source as isAuthenticated middleware)
    const token = req.cookies?.[COOKIE_NAME] || (req.headers.authorization && req.headers.authorization.split(' ')[1]);

    const chatEncKey = await ensureChatEncKey(userId);
    return res.status(200).json({ success: true, chatEncKey, userId, token });
  } catch (error: any) {
    Logger.error(`[session-key] Error: ${error.message || JSON.stringify(error)}`);
    return res.status(500).json({ success: false, error: 'Failed to retrieve session key' });
  }
});

// Logout endpoint - clears the HttpOnly auth cookie and revokes Hydra OAuth sessions.
// Uses optionalAuthentication so logout always succeeds even without a valid token,
// but if the user is identified we also clean up their Hydra sessions.
authOTPRouter.post('/logout', optionalAuthentication, async (req: Request, res: Response) => {
  // #swagger.tags = ['Auth']
  const userId = (req as any).user?.id;

  if (userId) {
    const HYDRA_ADMIN_URL = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';
    // Revoke Hydra login + consent sessions (best-effort, don't block logout)
    await Promise.allSettled([
      axios.delete(`${HYDRA_ADMIN_URL}/admin/oauth2/auth/sessions/login?subject=${userId}`),
      axios.delete(`${HYDRA_ADMIN_URL}/admin/oauth2/auth/sessions/consent?subject=${userId}`),
    ]);
  }

  clearAuthCookie(res);
  return res.status(200).json({ success: true, message: 'Logged out successfully' });
});
