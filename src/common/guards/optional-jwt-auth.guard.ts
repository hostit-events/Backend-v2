import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Same as `JwtAuthGuard` but never throws when the token is missing
 * or invalid — `req.user` is left undefined instead.
 *
 * Use on routes that work for both guests and signed-in users (e.g.
 * the public ticket-purchase endpoint, where an authenticated buyer
 * gets their `buyerId` linked but a guest can still check out).
 *
 * Pair with `@Public()` so the global `JwtAuthGuard` doesn't reject
 * the request before this guard runs.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  // Override so unauthenticated requests don't get a 401.
  handleRequest<TUser = unknown>(_err: unknown, user: TUser): TUser {
    return user ?? (null as unknown as TUser);
  }

  // Always allow the request through; passport still runs and populates
  // `req.user` if a valid JWT is present.
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(ctx);
    } catch {
      // Swallow — missing/invalid token is fine for optional auth.
    }
    return true;
  }
}
