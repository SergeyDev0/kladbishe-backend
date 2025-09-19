export type Point = { x: number; y: number };
export type BBox = { x: number; y: number; w: number; h: number };
export type DetectionJson = {
  polygon?: Point[]; // normalized [0..1]
  bbox?: BBox;       // normalized [0..1]
  coords_region?: BBox; // normalized [0..1]
  confidence?: number;
};

export type OcrJson = {
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  birth_date?: string;
  death_date?: string;
  coords_text?: string;
  full_text: string;
  language?: string;
};