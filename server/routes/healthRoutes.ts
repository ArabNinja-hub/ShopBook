import { FastifyInstance } from 'fastify';
import { DatabaseContext } from '../db/client';

export async function registerHealthRoutes(
  app: FastifyInstance,
  dbCtx: DatabaseContext
): Promise<void> {
  app.get('/api/v1/health', async (_request, reply) => {
    const dbOk = await dbCtx.ping().catch(() => false);
    if (!dbOk) {
      return reply.status(503).send({
        status: 'degraded',
        database: 'unreachable',
        apiVersion: 'v1',
        serverTime: new Date().toISOString(),
      });
    }
    return {
      status: 'ok',
      database: 'ok',
      engine: dbCtx.engine,
      apiVersion: 'v1',
      serverTime: new Date().toISOString(),
    };
  });
}
