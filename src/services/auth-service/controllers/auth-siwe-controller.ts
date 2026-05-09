import express, { Request, Response } from 'express';
import Logger from '../../../lib/logger';
import { memoryStoreNonce } from '../../../utils/global';
import { generateNonce, SiweMessage } from 'siwe';
import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';
import { LoginType, User } from '../../user-service/entity/user';
import { AppDataSource } from '../../../data-source';
import { AddUserSession, ensureChatEncKey } from '../utils/user';
import { setAuthCookie } from '../utils/cookie';
import * as dotenv from 'dotenv';
import { userOperations, authAttempts } from '../../../lib/metrics';

dotenv.config();

export const authSiweRouter = express.Router();
const userRepository = AppDataSource.getRepository(User);

const userRegisterViaWallet = async (address: string) => {
  let addedUser: any = {};
  const normalizedAddress = address.toLowerCase();
  // Case-insensitive lookup: compare lowercase on both sides
  const existingUser = await userRepository
    .createQueryBuilder('u')
    .where('LOWER(u.authAddress) = :address', { address: normalizedAddress })
    .getOne();
  if (existingUser) {
    Logger.info(`This user already exists!`);
    // Upgrade stub user if needed (created via sharing before sign-up)
    if (!existingUser.loginType || existingUser.loginType === '') {
      existingUser.loginType = LoginType.metamask;
      await userRepository.save(existingUser);
      Logger.info(`[SIWE] Upgraded stub user ${existingUser.id} to metamask login`);
    }
    // Track existing user login
    authAttempts.inc({ method: 'siwe', status: 'success' });
  } else {
    // If the user doesn't exist, insert a new row
    const newUser = await userRepository.create({
      authAddress: normalizedAddress,
      subscribe: false,
      loginType: LoginType.metamask,
    });
    Logger.info(`new user created with address: ${normalizedAddress}`);
    addedUser = await userRepository.save(newUser);

    // Track new user sign-up
    userOperations.inc({ operation: 'signup', status: 'success' });
    authAttempts.inc({ method: 'siwe', status: 'success' });
  }

  const userId = existingUser?.id ? existingUser?.id : addedUser?.id;
  const uniqueSessionId = await AddUserSession(userId);
  const chatEncKey = await ensureChatEncKey(userId);
  const token = jwt.sign({ id: userId, uniqueSessionId }, process.env.JWT_SECRET || '', {
    expiresIn: process.env.JWT_EXPIRY,
  });
  Logger.info(`jwt token generated for user id ${userId}`);
  return { token, user: existingUser?.id ? existingUser : addedUser, chatEncKey };
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
    const { token, user, chatEncKey } = await userRegisterViaWallet(address);

    // Set JWT as HttpOnly cookie (primary auth for web app)
    setAuthCookie(res, token);

    return res.status(200).json({ success: true, token, user, chatEncKey });
  } catch (err) {
    Logger.error(`Error occurred: ${err}`);
    // Track failed authentication attempt
    authAttempts.inc({ method: 'siwe', status: 'error' });
    res.status(401).send('Authentication failed');
  }
});
