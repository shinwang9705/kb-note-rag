/**
 * 设置路由（三期 T04）：GET/PATCH /api/settings。
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PatchSettingsInput } from '@kb/shared';
import type { AppConfig } from '../../config.js';
import type { DbHandle } from '../../db/connection.js';
import { createRequireAuthHook } from '../hooks/auth.js';
import { ok } from '../errors.js';
import {
  getSettings,
  patchSettings,
  type SettingsServiceContext,
} from '../../service/settings.service.js';

export interface SettingsRouteContext {
  db: DbHandle;
  config: AppConfig;
}

function svc(ctx: SettingsRouteContext): SettingsServiceContext {
  return { db: ctx.db, config: ctx.config };
}

export function createSettingsRoutes(ctx: SettingsRouteContext): FastifyPluginAsync {
  const requireAuth = createRequireAuthHook(ctx);

  return async function settingsRoutes(app) {
    app.get('/api/settings', { onRequest: [requireAuth] }, async (request) => {
      return ok(getSettings(svc(ctx), request.userId));
    });

    app.patch<{ Body: PatchSettingsInput }>(
      '/api/settings',
      {
        onRequest: [requireAuth],
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              generation: { type: 'object', additionalProperties: true },
              thinking: { type: 'object', additionalProperties: true },
              rag: { type: 'object', additionalProperties: true },
              ui: { type: 'object', additionalProperties: true },
              wizardCompleted: { type: 'boolean' },
            },
          },
        },
      },
      async (request: FastifyRequest<{ Body: PatchSettingsInput }>) => {
        const body = request.body ?? {};
        return ok({ settings: patchSettings(svc(ctx), request.userId, body) });
      },
    );
  };
}
