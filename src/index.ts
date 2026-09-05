import { app } from './app';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/database';
import { eventHub } from './common/sse/eventHub';

async function bootstrap() {
  try {
    await connectDatabase();

    const server = app.listen(env.PORT, () => {
      console.log('===============================================================');
      console.log(`🌊 WaveShift Nexus Engine Online [${env.NODE_ENV.toUpperCase()}]`);
      console.log(`📡 Server:      http://localhost:${env.PORT}`);
      console.log(`📖 Swagger UI:  http://localhost:${env.PORT}/docs`);
      console.log(`🎛️  War Room:   http://localhost:${env.PORT}/dashboard`);
      console.log('===============================================================');
    });

    const shutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);
      eventHub.teardown();
      server.close(async () => {
        await disconnectDatabase();
        console.log('🏁 WaveShift Nexus shutdown complete.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('❌ Fatal bootstrap failure:', error);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap();
}
