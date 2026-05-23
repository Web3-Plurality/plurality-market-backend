/**
 * No-op stub. The market stack has no bucket sharing, so there's nobody to
 * notify when context events fire (the actor is the only person with access).
 *
 * Kept as a stub so the controller call sites don't have to be rewritten
 * every time. Safe to inline-delete the callers if you want the noise gone.
 */

export function notifyShareMembers(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _profileId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _excludeUserId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _type: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _title: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _body?: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
  _metadata?: Record<string, any>,
): void {
  // intentionally empty
}
