import { Module } from '@nestjs/common';
import OpenAI from 'openai';

@Module({
  providers: [
    {
      provide: OpenAI,
      useFactory: () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }),
    },
  ],
  exports: [OpenAI],
})
export class OpenAIModule {}