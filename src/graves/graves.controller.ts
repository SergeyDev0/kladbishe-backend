import { BadRequestException, Body, Controller, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import path from 'node:path';
import { GravesService } from './graves.service';

const memoryStorage = multer.memoryStorage();

@Controller()
export class GravesController {
  constructor(private readonly svc: GravesService) {}

  
  @Post('crop')
  @UseInterceptors(FileInterceptor('image', { storage: memoryStorage }))
  async crop(@UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException('No image uploaded.');
    const outPath = await this.svc.cropBottomBanner(file.buffer, path.parse(file.originalname || 'image').name);
    const publicImageUrl = `/public/${path.basename(outPath)}`;
    return { imageUrl: publicImageUrl };
  }

  @Post('ocr')
  @UseInterceptors(FileInterceptor('image', { storage: memoryStorage }))
  async ocr(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No image');
    return this.svc.ocr(file.buffer);
  }

  @Post('crop-ocr')
  @UseInterceptors(FileInterceptor('image', { storage: memoryStorage }))
  async processImage(@UploadedFile() file?: Express.Multer.File, @Body() body?: { useSmartCrop?: boolean }) {
    if (!file?.buffer?.length) throw new BadRequestException('No image uploaded.');
    
    const baseName = path.parse(file.originalname || 'image').name;
    const useSmartCrop = body?.useSmartCrop !== false;
    
    const result = await this.svc.processImageWithOcr(file.buffer, baseName, useSmartCrop);

    // Подготовим данные под поля формы (camelCase) и публичный URL картинки
    const ocr = result.ocr as any;
    const publicImageUrl = `/public/${path.basename(result.croppedImagePath)}`;

    return {
      imageUrl: publicImageUrl,
      // Поля формы add
      firstName: ocr.first_name || '',
      lastName: ocr.last_name || '',
      middleName: ocr.middle_name || '',
      birthYear: ocr.birth_date || '',
      deathYear: ocr.death_date || '',
      locationText: ocr.coords_text || '',
      raw: {
        ocr: result.ocr,
        detection: result.detection,
        imageInfo: result.imageInfo,
        croppedImagePath: result.croppedImagePath,
      }
    };
  }

  @Post('saveData')
  @UseInterceptors(FileInterceptor('imageFile', { storage: memoryStorage }))
  async save(@UploadedFile() file?: Express.Multer.File, @Body() body: any = {}) {
    if (!body?.firstName && !body?.lastName) {
      throw new BadRequestException('Provide at least firstName or lastName');
    }

    let imageUrl: string | undefined;

    if (file?.buffer?.length) {
      const saved = await this.svc.saveImageBuffer(file.buffer, file.originalname);
      imageUrl = saved.publicUrl;
    } else if (body.imageFile && typeof body.imageFile === 'string') {
      imageUrl = body.imageFile;
    } else if (body.imageUrl) {
      imageUrl = body.imageUrl;
    }

    if (!imageUrl) {
      throw new BadRequestException('imageFile (file or text path) must be provided');
    }

    return this.svc.saveBurial({
      firstName: body.firstName,
      lastName: body.lastName,
      middleName: body.middleName,
      birthYear: body.birthYear,
      deathYear: body.deathYear,
      latitudeText: body.latitudeText,
      longitudeText: body.longitudeText,
      locationText: body.locationText,
      imageUrl,
    });
  }

  @Post('getData')
  async getData(@Body() body: any) {
    if (!body?.lastName) {
      throw new BadRequestException('lastName is required');
    }
		console.log(body);

    return this.svc.findBurialsByData({
      firstName: body.firstName,
      lastName: body.lastName,
      middleName: body.middleName,
      birthYear: body.birthYear,
      deathYear: body.deathYear,
      locationText: body.locationText,
    });
  }
}