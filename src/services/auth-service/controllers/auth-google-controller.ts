import * as dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import { Strategy as GoogleStrategy, VerifyCallback } from 'passport-google-oauth20';
import passport from 'passport';
import Logger from '../../../lib/logger';
import { AppDataSource } from '../../../data-source';
import { LoginType, User } from '../../user-service/entity/user';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { memoryStoreToken } from '../../../utils/global';
import { AddUserSession, ensureChatEncKey } from '../utils/user';
import { addMailchimpSubscriber } from '../utils/mailchimp';
import { setAuthCookie } from '../utils/cookie';
import { userOperations, authAttempts } from '../../../lib/metrics';

dotenv.config();
export const authGoogleRouter = express.Router();

const userRepository = AppDataSource.getRepository(User);

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      callbackURL: process.env.GOOGLE_CALLBACK_URL || '',
      passReqToCallback: true,
    },
    function (
      req: Request,
      accessToken: string,
      refreshToken: string,
      params: any,
      profile: any,
      done: VerifyCallback,
    ) {
      return done(null, { email: profile?._json?.email, googleJwtToken: params?.id_token });
    },
  ),
);

// Start the authentication flow
authGoogleRouter.get('/login', async (req: Request, res: Response, next) => {
  // #swagger.tags = ['Users-OAuth-Google']
  // #swagger.ignore = true
  try {
    // Store state for the callback
    const stateId = uuidv4();
    memoryStoreToken.set(stateId, { createdAt: Date.now() });

    Logger.info(`[GOOGLE AUTH] Starting OAuth with state: ${stateId}`);

    passport.authenticate('google', {
      scope: ['email'],
      state: stateId,
    })(req, res, next);
  } catch (error: any) {
    Logger.error(`[GOOGLE AUTH] Error starting OAuth: ${error.message}`);
    res.status(500).json({ error: 'Failed to start authentication' });
  }
});

// OAuth callback
authGoogleRouter.get(
  '/callback',
  passport.authenticate('google', { session: false }),
  async (req: Request, res: Response) => {
    // #swagger.tags = ['Users-OAuth-Google']
    // #swagger.ignore = true
    try {
      const stateId = req.query.state as string;
      const email = req?.user?.email;
      const googleJwtToken = req?.user?.googleJwtToken;

      if (!stateId) {
        Logger.error('[GOOGLE AUTH] No state parameter');
        return res.redirect(`${process.env.WIDGET_UI_URL}?error=missing_state`);
      }

      const stateData = memoryStoreToken.get(stateId);
      if (!stateData) {
        Logger.error('[GOOGLE AUTH] Invalid state');
        return res.redirect(`${process.env.WIDGET_UI_URL}?error=invalid_state`);
      }

      memoryStoreToken.delete(stateId);

      // Find or create user (case-insensitive email lookup)
      let userId: string;
      const normalizedEmail = email?.trim().toLowerCase();
      const existingUser = await userRepository
        .createQueryBuilder('u')
        .where('LOWER(u.email) = :email', { email: normalizedEmail })
        .getOne();

      if (existingUser) {
        Logger.info(`[GOOGLE AUTH] User exists: ${existingUser.id}`);
        userId = existingUser.id;
        authAttempts.inc({ method: 'google', status: 'success' });

        // Upgrade stub user if needed (created via sharing before sign-up)
        if (!existingUser.loginType || existingUser.loginType === '') {
          existingUser.loginType = LoginType.google;
          await userRepository.save(existingUser);
          Logger.info(`[GOOGLE AUTH] Upgraded stub user ${existingUser.id} to google login`);
        }
      } else {
        Logger.info(`[GOOGLE AUTH] Creating new user: ${normalizedEmail}`);
        const newUser = userRepository.create({ email: normalizedEmail, loginType: LoginType.google });
        const savedUser = await userRepository.save(newUser);
        userId = savedUser.id;
        userOperations.inc({ operation: 'signup', status: 'success' });
        authAttempts.inc({ method: 'google', status: 'success' });

        // Add to Mailchimp (fire-and-forget)
        addMailchimpSubscriber(normalizedEmail || '');
      }

      // Create session and JWT
      const uniqueSessionId = await AddUserSession(userId);
      const chatEncKey = await ensureChatEncKey(userId);
      const token = jwt.sign({ id: userId, uniqueSessionId }, process.env.JWT_SECRET || '', {
        expiresIn: process.env.JWT_EXPIRY,
      });

      // Set JWT as HttpOnly cookie (primary auth for web app)
      setAuthCookie(res, token);

      // Redirect to frontend with tokens (token still in URL for extension compatibility)
      const redirectUrl = `${process.env.WIDGET_UI_URL}?token=${token}&googleJwtToken=${encodeURIComponent(
        googleJwtToken || '',
      )}&chatEncKey=${encodeURIComponent(chatEncKey)}`;
      Logger.info(`[GOOGLE AUTH] Success! Redirecting to frontend`);
      res.redirect(redirectUrl);
    } catch (error: any) {
      Logger.error(`[GOOGLE AUTH] Callback error: ${error.message}`);
      authAttempts.inc({ method: 'google', status: 'error' });
      res.redirect(`${process.env.WIDGET_UI_URL}?error=auth_failed`);
    }
  },
);
