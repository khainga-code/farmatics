import type { FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized } from '../errors.js';
import { verifyAccessToken, type AccessClaims } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AccessClaims;
  }
}

export type Authenticate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Verifies the bearer token and attaches its claims. Permissions carried in
 * the token are for the phone's convenience; every write is checked again on
 * the server, which is the rule the plan requires for offline records.
 */
export function createAuthenticate(secret: string): Authenticate {
  return async function authenticate(request) {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw unauthorized();
    }
    try {
      request.auth = verifyAccessToken(header.slice('Bearer '.length).trim(), secret);
    } catch {
      throw unauthorized('Your session has expired. Sign in again.');
    }
  };
}

export function requireAuth(request: FastifyRequest): AccessClaims {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
