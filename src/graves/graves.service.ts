import { Injectable, InternalServerErrorException, BadRequestException } from '@nestjs/common';
import OpenAI from 'openai';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { BBox, DetectionJson, OcrJson, Point } from '../types';

@Injectable()
export class GravesService {
  private prisma = new PrismaClient();
  constructor(private readonly openai: OpenAI) {}

  /** Ask the model to locate the gravestone polygon and the bottom coordinates bbox. */
  async detectRegions(imageBuffer: Buffer, model = 'gpt-4o-mini'): Promise<DetectionJson> {
    const b64 = imageBuffer.toString('base64');
    const chat = await this.openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Locate the gravestone as a tight polygon in normalized coordinates [0..1] (3-12 points, clockwise). If unsure, return a bbox. Also locate a bbox of the coordinates text (usually at bottom) as coords_region. Return ONLY JSON with fields polygon?, bbox?, coords_region?, confidence?.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } }
          ]
        }
      ]
    });

    const msg = chat.choices[0].message;
    const t = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    try { return JSON.parse(t) as DetectionJson; }
    catch { throw new InternalServerErrorException('Detection JSON parse failed'); }
  }

  /** Build a transparent mask with an opaque polygon area. */
  private buildMaskSvg(width: number, height: number, poly: Point[]): string {
    const pts = poly.map(p => `${p.x},${p.y}`).join(' ');
    return `<?xml version="1.0"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${height}" fill="black" fill-opacity="0"/>
  <polygon points="${pts}" fill="white" fill-opacity="1"/>
</svg>`;
  }

  private denormPoints(poly: Point[], w: number, h: number): Point[] {
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    return poly.map(p => ({ x: clamp(Math.round(p.x * w), w), y: clamp(Math.round(p.y * h), h) }));
  }

  private bboxToPoly(b: BBox): Point[] {
    return [ {x:b.x, y:b.y}, {x:b.x+b.w, y:b.y}, {x:b.x+b.w, y:b.y+b.h}, {x:b.x, y:b.y+b.h} ];
  }

  async selectiveBlur(imageBuffer: Buffer, uploadDir: string, fileBase: string, blurSigma = 12): Promise<{imagePath: string, polygon: Point[]}> {
    const meta = await sharp(imageBuffer).metadata();
    const width = meta.width!, height = meta.height!;
    if (!width || !height) throw new InternalServerErrorException('Cannot read image size');

    const det = await this.detectRegions(imageBuffer);
    let poly = det.polygon;
    if (!poly || poly.length < 3) {
      if (!det.bbox) throw new InternalServerErrorException('Gravestone not found');
      poly = this.bboxToPoly(det.bbox);
    }
    const pxPoly = this.denormPoints(poly, width, height);

    const maskSvg = this.buildMaskSvg(width, height, pxPoly);
    const maskPng = await sharp(Buffer.from(maskSvg)).png().toBuffer();

    const blurred = await sharp(imageBuffer).blur(blurSigma).toBuffer();

    const foreground = await sharp(imageBuffer)
      .composite([{ input: maskPng, blend: 'dest-in' }])
      .toBuffer();

    const out = await sharp(blurred)
      .composite([{ input: foreground }])
      .jpeg()
      .toBuffer();

    await fs.mkdir(uploadDir, { recursive: true });
    const outPath = path.join(uploadDir, `${fileBase}.blur.jpg`);
    await fs.writeFile(outPath, out);

    return { imagePath: outPath, polygon: pxPoly };
  }

  async ocr(imageBuffer: Buffer, model = 'gpt-4o-mini'): Promise<{ ocr: OcrJson, detection: DetectionJson }> {
    const meta = await sharp(imageBuffer).metadata();
    const width = meta.width!, height = meta.height!;
    if (!width || !height) throw new InternalServerErrorException('Cannot read image size');

    const det = await this.detectRegions(imageBuffer, model);
    const mainB64 = imageBuffer.toString('base64');

    const content: any[] = [
      { type: 'text', text: 'Read all legible text from the gravestone. Extract first_name, last_name, middle_name (if present), birth_date, death_date. Extract coordinates text (coords_text) printed near the bottom of the photo if present. Return STRICT JSON with flat structure (no nested objects).' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${mainB64}`, detail: 'high' } }
    ];

    if (det.coords_region) {
      const cr = det.coords_region;
      const crop = {
        left: Math.max(0, Math.round(cr.x * width)),
        top: Math.max(0, Math.round(cr.y * height)),
        width: Math.max(1, Math.round(cr.w * width)),
        height: Math.max(1, Math.round(cr.h * height)),
      };
      crop.width = Math.min(crop.width, width - crop.left);
      crop.height = Math.min(crop.height, height - crop.top);

      try {
        const coordsBuf = await sharp(imageBuffer).extract(crop).jpeg().toBuffer();
        const coordsB64 = coordsBuf.toString('base64');
        content.splice(1, 0, { type: 'text', text: 'Second image is a tight crop of the coordinates text area. Use it primarily for coords_text.' });
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${coordsB64}`, detail: 'high' } });
      } catch {
        // ignore crop errors; proceed with main image
      }
    }

    const chat = await this.openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'user', content }
      ]
    });

    const msg = chat.choices[0].message;
    const t = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    let ocr: OcrJson;
    try { ocr = JSON.parse(t); }
    catch { throw new InternalServerErrorException('OCR JSON parse failed'); }

    return { ocr, detection: det };
  }

  async saveBurial(data: {
    firstName?: string;
    lastName?: string;
    middleName?: string;
    birthYear?: string;
    deathYear?: string;
    latitudeText?: string;
    longitudeText?: string;
    locationText?: string;
    imageUrl?: string;
  }) {
    let finalImagePath = data.imageUrl;

    // Если это локальный файл, обрезаем его
    if (data.imageUrl && !data.imageUrl.startsWith('http')) {
      try {
        const imageBuffer = await fs.readFile(data.imageUrl);
        const baseName = path.basename(data.imageUrl, path.extname(data.imageUrl));
        const croppedPath = await this.smartCropBottomBanner(imageBuffer, baseName);
        finalImagePath = croppedPath;
      } catch (error) {
        console.warn('Не удалось обрезать изображение:', error.message);
        // Используем оригинальный путь если обрезка не удалась
      }
    }

    return this.prisma.burial.create({
      data: {
        firstName: data.firstName ?? null,
        lastName: data.lastName ?? null,
        middleName: data.middleName ?? null,
        birthDate: data.birthYear ?? null,
        deathDate: data.deathYear ?? null,
        latitudeText: data.latitudeText ?? null,
        longitudeText: data.longitudeText ?? null,
        locationText: data.locationText ?? null,
        imagePath: finalImagePath,
      },
    });
  }

  /** Сохранение буфера изображения в uploads и генерация публичного URL */
  async saveImageBuffer(imageBuffer: Buffer, originalName?: string): Promise<{ filePath: string; publicUrl: string; fileName: string; }> {
    const uploadDir = path.join(process.cwd(), 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });

    // Определяем расширение
    let ext = '.jpg';
    if (originalName) {
      const parsed = path.parse(originalName);
      if (parsed.ext) ext = parsed.ext;
    }

    // Генерируем уникальное имя с UUID
    const uuid = randomUUID();
    const base = originalName ? path.parse(originalName).name : 'image';
    const uniqueBase = `${base}-${uuid}`;
    
    // Обрезаем изображение и сохраняем
    try {
      const croppedPath = await this.smartCropBottomBanner(imageBuffer, uniqueBase);
      const croppedFileName = path.basename(croppedPath);
      
      const publicUrl = `/public/${croppedFileName}`;
      return { filePath: croppedPath, publicUrl, fileName: croppedFileName };
    } catch (error) {
      console.warn('Не удалось обрезать изображение, используем обычную обрезку:', error.message);
      const croppedPath = await this.cropBottomBanner(imageBuffer, uniqueBase);
      const croppedFileName = path.basename(croppedPath);
      
      const publicUrl = `/public/${croppedFileName}`;
      return { filePath: croppedPath, publicUrl, fileName: croppedFileName };
    }
  }

  async findBurials(criteria: { firstName?: string; lastName?: string; birthYear?: string; deathYear?: string; latitudeText?: string; longitudeText?: string; locationText?: string; }): Promise<any[]> {
    const where: any = {};
    if (criteria.firstName) where.firstName = { contains: criteria.firstName };
    if (criteria.lastName) where.lastName = { contains: criteria.lastName };
    if (criteria.latitudeText) where.latitudeText = { contains: criteria.latitudeText };
    if (criteria.longitudeText) where.longitudeText = { contains: criteria.longitudeText };
    if (criteria.locationText) where.locationText = { contains: criteria.locationText };
    if (criteria.birthYear) where.birthDate = { startsWith: criteria.birthYear };
    if (criteria.deathYear) where.deathDate = { startsWith: criteria.deathYear };

    return this.prisma.burial.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async findBurialsByData(criteria: { firstName?: string; lastName: string; middleName?: string; birthYear?: string; deathYear?: string; locationText?: string; }): Promise<any[]> {
    // Получаем ВСЕ записи и фильтруем в памяти
    const allBurials = await this.prisma.burial.findMany({
      orderBy: { createdAt: 'desc' }
    });


    // Фильтруем с нечувствительностью к регистру
    const filtered = allBurials.filter(burial => {
      
      // Фамилия обязательна
      if (!burial.lastName?.toLowerCase().includes(criteria.lastName.toLowerCase())) {
        return false;
      }

      // Остальные поля опциональны
      if (criteria.firstName && !burial.firstName?.toLowerCase().includes(criteria.firstName.toLowerCase())) {
        return false;
      }

      if (criteria.middleName && !burial.middleName?.toLowerCase().includes(criteria.middleName.toLowerCase())) {
        return false;
      }

      if (criteria.locationText && !burial.locationText?.toLowerCase().includes(criteria.locationText.toLowerCase())) {
        return false;
      }

      if (criteria.birthYear && !burial.birthDate?.startsWith(criteria.birthYear)) {
        return false;
      }

      if (criteria.deathYear && !burial.deathDate?.startsWith(criteria.deathYear)) {
        return false;
      }

      return true;
    });

    // Преобразуем imagePath в публичный URL для обрезанной картинки
    return filtered.map(burial => ({
      ...burial,
      imagePath: burial.imagePath.startsWith('http') 
        ? burial.imagePath 
        : `/public/${path.basename(burial.imagePath)}`
    }));
  }

  async cropBottomBanner(imageBuffer: Buffer, baseName: string): Promise<string> {
    try {
      const metadata = await sharp(imageBuffer).metadata();
      const format = metadata.format || 'jpeg';
      const width = metadata.width;
      const height = metadata.height;
      
      // Валидация формата
      if (!['jpeg', 'png', 'webp', 'tiff', 'gif'].includes(format)) {
        throw new BadRequestException('Unsupported image format. Supported formats: JPEG, PNG, WebP, TIFF, GIF');
      }

      // Валидация размеров изображения
      if (!width || !height || width <= 0 || height <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
        throw new BadRequestException(`Invalid image dimensions: width=${width}, height=${height}`);
      }

      // Конвертируем в JPEG для обработки (если нужно)
      let processedBuffer = imageBuffer;
      if (format !== 'jpeg') {
        processedBuffer = await sharp(imageBuffer).jpeg().toBuffer();
      }

      // Автоматическое определение области для обрезки (нижние 12%)
      const cropHeight = Math.floor(height * 0.12);
      
      // Валидация cropHeight
      if (!Number.isInteger(cropHeight) || cropHeight < 0 || cropHeight >= height) {
        throw new BadRequestException('Invalid crop height calculation');
      }

      const finalHeight = height - cropHeight;
      if (finalHeight <= 0) {
        throw new BadRequestException('Crop height is too large, would result in zero or negative image height');
      }

      const cropOptions = {
        left: 0,
        top: 0,
        width: width,
        height: finalHeight
      };

      // Обрезаем изображение
      const croppedBuffer = await sharp(processedBuffer)
        .extract(cropOptions)
        .toBuffer();

      // Сохраняем в оригинальном формате
      const uploadDir = path.join(process.cwd(), 'uploads');
      await fs.mkdir(uploadDir, { recursive: true });

      // Генерируем уникальное имя с UUID
      const uuid = randomUUID();
      const cleanBase = path.basename(baseName, path.extname(baseName));
      const uniqueBase = `${cleanBase}-${uuid}`;
      const outPath = path.join(uploadDir, `${uniqueBase}.cropped.${format}`);

      // Сохраняем в соответствующем формате
      if (format === 'png') {
        await sharp(croppedBuffer).png().toFile(outPath);
      } else if (format === 'webp') {
        await sharp(croppedBuffer).webp().toFile(outPath);
      } else if (format === 'tiff') {
        await sharp(croppedBuffer).tiff().toFile(outPath);
      } else if (format === 'gif') {
        await sharp(croppedBuffer).gif().toFile(outPath);
      } else {
        await sharp(croppedBuffer).jpeg().toFile(outPath);
      }

      return outPath;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException('Failed to crop image: ' + error.message);
    }
  }

  /** Альтернативный метод обрезки с использованием AI для определения координатной области */
  async smartCropBottomBanner(imageBuffer: Buffer, baseName: string): Promise<string> {
    try {
      // Получаем метаданные изображения с валидацией
      const metadata = await sharp(imageBuffer).metadata();
      const format = metadata.format || 'jpeg';
      const width = metadata.width;
      const height = metadata.height;

      // Валидация размеров изображения
      if (!width || !height || width <= 0 || height <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
        throw new BadRequestException(`Invalid image dimensions: width=${width}, height=${height}`);
      }

      // Получаем детекцию областей
      const detection = await this.detectRegions(imageBuffer);

      // Определяем высоту обрезки на основе координатной области или фиксированного процента
      let cropHeight = Math.floor(height * 0.15); // по умолчанию 15%

      if (detection.coords_region) {
        // Если найдена координатная область, обрезаем немного ниже нее
        const coordsRegion = detection.coords_region;
        const coordsBottom = Math.round((coordsRegion.y + coordsRegion.h) * height);
        cropHeight = height - coordsBottom + Math.floor(height * 0.05); // +5% отступа
      }

      // Ограничиваем обрезку разумными пределами
      cropHeight = Math.max(Math.floor(height * 0.05), Math.min(Math.floor(height * 0.4), cropHeight));

      // Дополнительная валидация cropHeight
      if (!Number.isInteger(cropHeight) || cropHeight < 0 || cropHeight >= height) {
        cropHeight = Math.floor(height * 0.15); // fallback к 15%
      }

      const finalHeight = height - cropHeight;
      if (finalHeight <= 0) {
        throw new BadRequestException('Crop height is too large, would result in zero or negative image height');
      }

      const cropOptions = {
        left: 0,
        top: 0,
        width: width,
        height: finalHeight
      };

      // Обрезаем и сохраняем
      const croppedBuffer = await sharp(imageBuffer)
        .extract(cropOptions)
        .toBuffer();

      const uploadDir = path.join(process.cwd(), 'uploads');
      await fs.mkdir(uploadDir, { recursive: true });

      // Генерируем уникальное имя с UUID
      const uuid = randomUUID();
      const cleanBase = path.basename(baseName, path.extname(baseName));
      const uniqueBase = `${cleanBase}-${uuid}`;
      const outPath = path.join(uploadDir, `${uniqueBase}.smart-cropped.${format}`);

      await sharp(croppedBuffer).toFormat(format as any).toFile(outPath);

      return outPath;
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new InternalServerErrorException('Failed to smart crop image: ' + error.message);
    }
  }

  /** Улучшенная обработка различных форматов изображений */
  async processImage(imageBuffer: Buffer, format?: string): Promise<Buffer> {
    try {
      if (!format) {
        const metadata = await sharp(imageBuffer).metadata();
        format = metadata.format || 'jpeg';
      }

      // Конвертируем в JPEG для единообразной обработки
      return await sharp(imageBuffer)
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer();
    } catch (error) {
      throw new BadRequestException('Failed to process image: ' + error.message);
    }
  }

  /** Получение информации об изображении */
  async getImageInfo(imageBuffer: Buffer): Promise<{
    format: string;
    width: number;
    height: number;
    size: number;
  }> {
    try {
      const metadata = await sharp(imageBuffer).metadata();
      return {
        format: metadata.format || 'unknown',
        width: metadata.width || 0,
        height: metadata.height || 0,
        size: imageBuffer.length
      };
    } catch (error) {
      throw new BadRequestException('Failed to get image info: ' + error.message);
    }
  }

  /** Объединенный метод: OCR + обрезка изображения */
  async processImageWithOcr(imageBuffer: Buffer, baseName: string, useSmartCrop = true): Promise<{
    ocr: OcrJson;
    detection: DetectionJson;
    croppedImagePath: string;
    imageInfo: {
      format: string;
      width: number;
      height: number;
      size: number;
    };
  }> {
    try {
      // 1. Получаем информацию об изображении
      const imageInfo = await this.getImageInfo(imageBuffer);

      // 2. Выполняем OCR для распознавания текста
      const { ocr, detection } = await this.ocr(imageBuffer);

      // 3. Обрезаем изображение (умная обрезка или обычная)
      let croppedImagePath: string;
      
      if (useSmartCrop) {
        try {
          croppedImagePath = await this.smartCropBottomBanner(imageBuffer, baseName);
        } catch (smartCropError) {
          // Fallback к обычной обрезке если умная обрезка не удалась
          console.warn('Smart crop failed, falling back to regular crop:', smartCropError.message);
          croppedImagePath = await this.cropBottomBanner(imageBuffer, baseName);
        }
      } else {
        croppedImagePath = await this.cropBottomBanner(imageBuffer, baseName);
      }

      return {
        ocr,
        detection,
        croppedImagePath,
        imageInfo
      };
    } catch (error) {
      throw new InternalServerErrorException('Failed to process image with OCR: ' + error.message);
    }
  }
}