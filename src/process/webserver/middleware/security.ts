/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 * Modified by Ferrox Labs in 2026. Changes are documented in the project history.
 */

import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SECURITY_CONFIG } from '@process/webserver/config/constants';

/**
 * Rate-limit for sensitive operations like login/register
 */
export const authRateLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: 'Too many authentication attempts. Please try again later.',
  },
  skipSuccessfulRequests: true,
});

/**
 * Rate-limit for general API requests
 */
export const apiRateLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60 * 1000,
  max: 60,
  message: {
    error: 'Too many API requests, please slow down.',
  },
});

/**
 * Rate-limit for file-browsing and similar operations
 */
export const fileOperationLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60 * 1000,
  max: 30,
  message: {
    error: 'Too many file operations, please slow down.',
  },
});

/**
 * Rate-limit for sensitive actions by authenticated users (keyed by user ID, falling back to IP)
 */
export const authenticatedActionLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'Too many sensitive actions, please try again later.',
  },
  keyGenerator: (req: Request) => {
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  },
});

/**
 * Attach CSRF token to response for client-side usage
 * tiny-csrf provides req.csrfToken() method to generate tokens
 */
export function attachCsrfToken(req: Request, res: Response, next: NextFunction): void {
  // tiny-csrf provides req.csrfToken() method
  if (typeof req.csrfToken === 'function') {
    const token = req.csrfToken();
    res.setHeader(CSRF_HEADER_NAME, token);

    // LOCAL PATCH (not upstream): publish the token as a JS-readable mirror cookie.
    //
    // The browser client reads the token from exactly this cookie
    // (csrfClient.getCsrfToken -> readCookie(CSRF_COOKIE_NAME)), but nothing in the
    // server ever set it: tiny-csrf's own `csrfToken` cookie is HttpOnly (so
    // document.cookie cannot see it), the x-csrf-token response header is never
    // captured by the renderer, and res.locals.csrfToken has no consumer. So
    // getCsrfToken() always returned null and EVERY CSRF-protected write failed with
    // `csrf_invalid` ("Security token missing or expired"). Login was the exception
    // only because /login is on the tiny-csrf exclusion list.
    //
    // SECURITY_CONFIG.CSRF.COOKIE_OPTIONS already declares httpOnly:false for this
    // purpose, so this is the intended double-submit design with the write wired up.
    // Exposing the raw token to JS is standard double-submit (cf. Django csrftoken,
    // Angular XSRF-TOKEN); the authority remains tiny-csrf's signed HttpOnly cookie.
    //
    // `secure` follows req.secure so it is set behind the TLS proxy but still works
    // for a plain-HTTP loopback probe. maxAge matches tiny-csrf's 300s cookie so the
    // mirror can never outlive the token it mirrors and hand back a stale value.
    res.cookie(CSRF_COOKIE_NAME, token, {
      ...SECURITY_CONFIG.CSRF.COOKIE_OPTIONS,
      secure: req.secure,
      maxAge: 300_000,
    });

    res.locals.csrfToken = token;
  }
  next();
}

/**
 * Generic rate-limiter factory for use cases like static routes
 */
export function createRateLimiter(options: Parameters<typeof rateLimit>[0]) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
  });
}
