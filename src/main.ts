import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import cors from 'cors';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const dir = process.env.UPLOAD_DIR || './uploads';
  app.use(cors());
  app.use('/public', express.static(path.resolve(dir)));
  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
}
bootstrap();