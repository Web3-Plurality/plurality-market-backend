declare namespace Express {
    interface Request {
      user?: { id?: string; uniqueSessionId?: string, accessToken?: string, accountId?: string, email?: string, googleJwtToken?: string, authMethod?: 'native' | 'pat' | 'hydra' }; // Replace with IToken if you have an interface
      sseID?: string;
      accessTokenID?: string;
      clientApp?: any;
      email: string;
      rawBody?: string;
      subscription?: {
        id: string;
        planType: string;
        creditsRemaining: number;
        expiresAt: Date | null;
        isValid: boolean;
        hasValidAccess?: boolean;
      } | null;
    }
  }
  