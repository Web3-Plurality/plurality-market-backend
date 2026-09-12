import express, { Request, Response } from 'express';
import Logger from '../../../lib/logger';
import { memoryStoreNonce } from '../../../utils/global';
import { generateNonce, SiweMessage } from 'siwe';
import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';
import { LoginType, User } from '../../user-service/entity/user';
import { AppDataSource } from '../../../data-source';
import { setAuthCookie, clearAuthCookie, COOKIE_NAME } from '../utils/cookie';
import { isAuthenticated } from '../../user-service/middlewares/auth-middleware';
import { isAdminWallet } from '../../user-service/utils/admin-wallets';
import { revokeAutoTokensForUser } from '../../token-service/utils/auto-pat';
import * as dotenv from 'dotenv';

dotenv.config();

export const authSiweRouter = express.Router();
const userRepository = AppDataSource.getRepository(User);

// Find an existing user by case-insensitive authAddress. Used by both the
// initial check and the race-condition fallback below.
const findUserByLoweredAddress = (normalizedAddress: string) =>
  userRepository
    .createQueryBuilder('u')
    .where('LOWER(u.authAddress) = :address', { address: normalizedAddress })
    .getOne();

const userRegisterViaWallet = async (address: string) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let addedUser: any = {};
  const normalizedAddress = address.toLowerCase();
  let existingUser = await findUserByLoweredAddress(normalizedAddress);
  if (existingUser) {
    Logger.info(`This user already exists!`);
    if (!existingUser.loginType || existingUser.loginType === '') {
      existingUser.loginType = LoginType.metamask;
      await userRepository.save(existingUser);
      Logger.info(`[SIWE] Upgraded stub user ${existingUser.id} to metamask login`);
    }
  } else {
    // Race-safe insert: two concurrent SIWE calls for the same wallet could
    // both miss the existing-user check above and try to insert. If a
    // functional UNIQUE index exists on LOWER(authAddress), the second insert
    // throws — catch it, re-fetch, and use the row the other request created.
    try {
      const newUser = userRepository.create({
        authAddress: normalizedAddress,
        loginType: LoginType.metamask,
      });
      addedUser = await userRepository.save(newUser);
      Logger.info(`new user created with address: ${normalizedAddress}`);
    } catch (err) {
      // Unique-violation from the functional index — another request won.
      existingUser = await findUserByLoweredAddress(normalizedAddress);
      if (!existingUser) {
        Logger.error('[SIWE] Insert raced AND re-fetch returned null', err);
        throw err;
      }
      Logger.info(`[SIWE] Insert raced; using existing user ${existingUser.id}`);
    }
  }

  const userId = existingUser?.id ? existingUser?.id : addedUser?.id;
  // Wallet address is the canonical identifier across the stack. `id` is
  // carried alongside as a denormalized perf shortcut so protected routes
  // can read `req.user.id` without a User-table lookup per request.
  const token = jwt.sign({ authAddress: normalizedAddress, id: userId }, process.env.JWT_SECRET || '', {
    expiresIn: process.env.JWT_EXPIRY,
  });
  Logger.info(`jwt token generated for wallet ${normalizedAddress} (user ${userId})`);
  return { token, user: existingUser?.id ? existingUser : addedUser };
};

//generate random string to take user signature
authSiweRouter.post('/login', (req: Request, res: Response) => {
  // #swagger.tags = ['Auth']
  try {
    const walletAddress: string = req.body.address;

    // Validate address is provided
    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // Validate address is a string
    if (typeof walletAddress !== 'string') {
      return res.status(400).json({ error: 'Wallet address must be a string' });
    }

    // Validate address length
    if (walletAddress.length > 200) {
      return res.status(400).json({ error: 'Wallet address is too long' });
    }

    if (!ethers.isAddress(walletAddress)) {
      Logger.error(`Fatal error due to invalid wallet address: ${walletAddress}`);
      return res.status(400).json({ error: 'Invalid wallet address' });
    } else {
      const nonce = generateNonce();
      memoryStoreNonce.set(walletAddress.toLowerCase(), nonce);
      Logger.info(`Nonce generated for address ${walletAddress}: ${nonce}`);
      return res.status(200).json({ message: 'success', nonce });
    }
  } catch (error: any) {
    Logger.error(`Fatal error due to unknown reason: ${JSON.stringify(error)}`);
    return res.status(500).json({ error: 'An error occurred while processing your request' });
  }
});
// address, subscribe
authSiweRouter.post('/authenticate', async function (req: Request, res: Response) {
  // #swagger.tags = ['Auth']
  try {
    const { address }: { address: string } = req.body;

    // Validate address
    if (!address) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    if (typeof address !== 'string') {
      return res.status(400).json({ error: 'Wallet address must be a string' });
    }

    if (address.length > 200) {
      return res.status(400).json({ error: 'Wallet address is too long' });
    }

    if (!ethers.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Validate x-siwe header
    if (!req.headers['x-siwe']) {
      return res.status(400).json({ error: 'SIWE header is required' });
    }

    const siweObj = req.headers['x-siwe']
      ? JSON.parse(Array.isArray(req.headers['x-siwe']) ? req.headers['x-siwe'][0] : req.headers['x-siwe'])
      : '';

    if (!siweObj || !siweObj.siwe || !siweObj.message) {
      return res.status(400).json({ error: 'Invalid SIWE header format' });
    }

    const siweToken = siweObj?.siwe;
    const message = decodeURIComponent(siweObj?.message);
    const nonce = memoryStoreNonce.get(address.toLowerCase());
    const siweMessage = new SiweMessage(message);
    const siweResponse = await siweMessage.verify({ signature: siweToken });
    // check nonce
    if (!nonce) {
      Logger.error(`Invalid nonce`);
      return res.status(400).send('Invalid nonce');
    }
    // delete nonce with the address
    memoryStoreNonce.delete(address.toLowerCase());
    // check signature
    if (!siweResponse.success) {
      Logger.error(`Invalid siwe token`);
      return res.status(400).send('Invalid siwe token');
    }
    if (siweMessage?.address?.toLowerCase() !== address?.toLowerCase()) {
      Logger.error(`Invalid siwe token`);
      return res.status(400).send('Invalid siwe token');
    }
    // create jwt token
    Logger.info(`user authenticated successfully by address ${address}`);
    const { token, user } = await userRegisterViaWallet(address);

    // Set JWT as HttpOnly cookie (primary auth for web app)
    setAuthCookie(res, token);

    return res.status(200).json({ success: true, token, user });
  } catch (err) {
    Logger.error(`Error occurred: ${err}`);
    res.status(401).send('Authentication failed');
  }
});

// POST /auth/siwe/logout — clear the HttpOnly auth cookie.
// Always returns 200 even if there was no cookie; logout shouldn't error.
authSiweRouter.post('/logout', async (req: Request, res: Response) => {
  // #swagger.tags = ['Auth']
  // Best-effort: if the cookie still decodes, kill the user's auto chat
  // tokens so a token lifted from a browser tab stops working the moment
  // they log out. Never fail logout over this — no middleware, no throw.
  try {
    const raw = req.cookies?.[COOKIE_NAME];
    if (raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = jwt.verify(raw, process.env.JWT_SECRET || '') as any;
      if (payload?.id) await revokeAutoTokensForUser(payload.id);
    }
  } catch {
    // expired / malformed cookie — nothing to revoke against
  }
  clearAuthCookie(res);
  return res.status(200).json({ success: true });
});

// GET /auth/siwe/session — used by the frontend on page load to probe whether
// the HttpOnly cookie is still valid. Returns the resolved user info if so,
// 401 otherwise. Lighter than calling a protected endpoint and inferring auth
// from the response shape.
authSiweRouter.get('/session', isAuthenticated, async (req: Request, res: Response) => {
  // #swagger.tags = ['Auth']
  try {
    const userId = req?.user?.id;
    const authAddress = req?.user?.authAddress;
    if (!userId || !authAddress) {
      return res.status(401).json({ success: false });
    }
    // isAdmin lets the UI show team-only curation controls (e.g. the
    // "feature on homepage" toggle). Informational only: every curation
    // endpoint re-checks the allowlist server-side.
    return res.status(200).json({ success: true, userId, authAddress, isAdmin: isAdminWallet(authAddress) });
  } catch (err) {
    Logger.error(`[siwe/session] error: ${err}`);
    return res.status(500).json({ success: false });
  }
});
