// reflect-metadata must be imported exactly once, before any Nest decorators run.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Ensures RefPoolService.onApplicationShutdown() runs -> pool.drain()
  // (every per-tenant pg Pool gets `.end()`ed) on SIGINT/SIGTERM.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  console.log(`nest-multitenant listening on http://localhost:${port}`);
  console.log('Try:');
  console.log(`  curl -H 'x-tenant-id: acme'  http://localhost:${port}/tenant/now`);
  console.log(`  curl -H 'x-tenant-id: globex' http://localhost:${port}/tenant/report`);
  console.log(`  curl                          http://localhost:${port}/tenant/stats`);
  console.log(`  curl                          http://localhost:${port}/health/connections`);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
