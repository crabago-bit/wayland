/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JARVIS autonomy reads for a remote WebUI client.
 *
 * READ-ONLY by construction - there is no write verb here. The approvals ledger
 * is appended by the MCP tool-filter shim as a side effect of enforcement, and
 * the rung itself is changed from the Agents settings page through the existing
 * config rail. A route that could edit either would turn the ledger into a
 * record of what someone was willing to admit.
 *
 * Gates match the other read routes: `apiRateLimiter` + `validateApiAccess`
 * (token auth) as route middleware. No `requireSecureConfigWrite` because
 * nothing is written and no secret is returned; the ledger holds tool names,
 * connector names, decisions and reasons, all of which the caller's own agent
 * already knows.
 *
 * The equivalent local surface is `ipcBridge.jarvis.*`, which is denied to
 * paired-device WebSocket callers by the `jarvis.` prefix in bridgeAllowlist.ts.
 * This route is the rail remote callers use instead, and both go through the
 * SAME reader (`listApprovals`) so they cannot disagree about what happened.
 */

import { type Express, type Request, type RequestHandler, type Response } from 'express';
import { apiRateLimiter } from '../middleware/security';
import { describeHardFloor, listApprovals } from '@process/bridge/jarvisBridge';
import { APPROVALS_PAGE_SIZE } from '@process/services/jarvis/approvalsLog';

/** Parse `?limit=` defensively - the reader caps it too, this just avoids NaN. */
function parseLimit(value: unknown): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, APPROVALS_PAGE_SIZE) : APPROVALS_PAGE_SIZE;
}

export function registerJarvisRoutes(app: Express, validateApiAccess: RequestHandler): void {
  // GET /api/jarvis/approvals?limit=200
  // Newest-first page of the approvals ledger plus the effective hard floor, so
  // the Approvals view can render the badge and the floor without a second call.
  app.get('/api/jarvis/approvals', apiRateLimiter, validateApiAccess, (req: Request, res: Response) => {
    try {
      res.json({
        success: true,
        data: { approvals: listApprovals(parseLimit(req.query?.limit)), hardFloor: describeHardFloor() },
      });
    } catch (error) {
      console.error('[API] Jarvis approvals read error:', error);
      res.status(500).json({ success: false, msg: 'Failed to read the approvals ledger' });
    }
  });
}
