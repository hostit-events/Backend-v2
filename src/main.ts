import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

// Teach JSON.stringify how to handle BigInt. Prisma returns BigInt for
// columns like TicketType.onChainTicketId (on-chain uint64), and the
// default serializer throws "Do not know how to serialize a BigInt".
// Emit as a string to avoid precision loss beyond Number.MAX_SAFE_INTEGER.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON =
  function () {
    return this.toString();
  };

async function bootstrap() {
  // rawBody enables Paystack/Monnify webhook signature verification
  // against the unmodified request payload.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);

  // Global prefix
  app.setGlobalPrefix('api');

  // CORS — driven by CORS_ORIGINS env var. Comma-separated list of
  // allowed origins. Empty / unset means allow all (dev convenience).
  // Production deployments MUST set this to the FE domain(s).
  const corsOrigins = configService.get<string>('CORS_ORIGINS');
  if (corsOrigins && corsOrigins.trim().length > 0) {
    const origins = corsOrigins
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    app.enableCors({ origin: origins, credentials: true });
    Logger.log(`CORS restricted to: ${origins.join(', ')}`, 'Bootstrap');
  } else {
    app.enableCors();
    if (configService.get<string>('app.nodeEnv') === 'production') {
      Logger.warn(
        'CORS is wide open in production — set CORS_ORIGINS to lock it down',
        'Bootstrap',
      );
    }
  }

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global filters & interceptors
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TransformInterceptor(),
  );

  // Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('HostIT v2 API')
    .setDescription('Web3 Event Ticketing Platform')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(port);
  Logger.log(
    `Application running on http://localhost:${port}/api`,
    'Bootstrap',
  );
  Logger.log(`Swagger docs at http://localhost:${port}/api/docs`, 'Bootstrap');
}
void bootstrap();
