declare namespace Express {
  interface Request {
    user?: { id?: string; authAddress?: string; authMethod?: 'native' | 'pat' };
  }
}
