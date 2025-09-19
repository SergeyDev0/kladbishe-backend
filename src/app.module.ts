import { Module } from '@nestjs/common';
import { OpenAIModule } from './openai/openai.module';
import { GravesController } from './graves/graves.controller';
import { GravesService } from './graves/graves.service';

@Module({
  imports: [OpenAIModule],
  controllers: [GravesController],
  providers: [GravesService],
})
export class AppModule {}