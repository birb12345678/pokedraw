// The eleven buckets turn millions of possible RGB colors into a small,
// readable summary that is useful for comparing Pokémon palettes.
export const COLOR_BUCKETS = [
  'Red', 'Orange', 'Yellow', 'Green', 'Teal/Cyan', 'Blue',
  'Purple', 'Pink', 'Brown', 'Gray/White', 'Black'
];

const ALPHA_CUTOFF = 16;
const GRID_SIZE = 16;
const INDEX_URL = 'https://pokeapi.co/api/v2/pokemon?limit=151';
const SPRITE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

// Classify a pixel by brightness first, then hue. Brown is treated separately
// from orange because many ground-type sprites use a dark, low-saturation orange.
export function colorBucketIndex(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const brightness = maximum / 255;
  const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;

  if (brightness < 0.16) return 10;
  if (saturation < 0.18) return 9;

  const redUnit = red / 255;
  const greenUnit = green / 255;
  const blueUnit = blue / 255;
  const difference = (maximum - minimum) / 255;
  let hue;

  if (difference === 0) hue = 0;
  else if (maximum === red) hue = 60 * (((greenUnit - blueUnit) / difference) % 6);
  else if (maximum === green) hue = 60 * ((blueUnit - redUnit) / difference + 2);
  else hue = 60 * ((redUnit - greenUnit) / difference + 4);
  if (hue < 0) hue += 360;

  if (hue < 15 || hue >= 345) return 0;
  if (hue < 40) return brightness < 0.62 ? 8 : 1;
  if (hue < 68) return 2;
  if (hue < 155) return 3;
  if (hue < 195) return 4;
  if (hue < 255) return 5;
  if (hue < 290) return 6;
  if (hue < 345) return 7;
  return 0;
}

// Find visible pixels on an image with transparency. The CSS white canvas
// background is not part of its pixel data, so white brush marks remain visible.
function findAlphaBounds(imageData) {
  const { data, width, height } = imageData;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < ALPHA_CUTOFF) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

// Convert a source canvas into the same compact fingerprint for both reference
// sprites and the user's drawing. Cropping first makes position and scale matter less.
export function createVisualFingerprint(sourceCanvas) {
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const imageData = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const bounds = findAlphaBounds(imageData);
  if (!bounds) return null;

  const histogramCounts = new Array(COLOR_BUCKETS.length).fill(0);
  let visiblePixelWeight = 0;
  const { data, width } = imageData;

  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3] / 255;
      if (alpha * 255 < ALPHA_CUTOFF) continue;
      const bucket = colorBucketIndex(data[offset], data[offset + 1], data[offset + 2]);
      histogramCounts[bucket] += alpha;
      visiblePixelWeight += alpha;
    }
  }

  // Fit the cropped art into a padded square without stretching it. This keeps
  // the silhouette's proportions intact while still aligning small and large art.
  const normalizedCanvas = document.createElement('canvas');
  normalizedCanvas.width = GRID_SIZE;
  normalizedCanvas.height = GRID_SIZE;
  const normalizedContext = normalizedCanvas.getContext('2d', { willReadFrequently: true });
  normalizedContext.clearRect(0, 0, GRID_SIZE, GRID_SIZE);
  normalizedContext.imageSmoothingEnabled = true;
  const scale = Math.min(14 / bounds.width, 14 / bounds.height);
  const drawWidth = bounds.width * scale;
  const drawHeight = bounds.height * scale;
  const drawX = (GRID_SIZE - drawWidth) / 2;
  const drawY = (GRID_SIZE - drawHeight) / 2;
  normalizedContext.drawImage(
    sourceCanvas,
    bounds.x, bounds.y, bounds.width, bounds.height,
    drawX, drawY, drawWidth, drawHeight
  );

  const normalizedPixels = normalizedContext.getImageData(0, 0, GRID_SIZE, GRID_SIZE).data;
  const grid = [];
  for (let index = 0; index < GRID_SIZE * GRID_SIZE; index += 1) {
    const offset = index * 4;
    grid.push({
      r: normalizedPixels[offset],
      g: normalizedPixels[offset + 1],
      b: normalizedPixels[offset + 2],
      a: normalizedPixels[offset + 3] / 255
    });
  }

  const histogram = histogramCounts.map((count) => count / visiblePixelWeight);
  return {
    grid,
    histogram,
    aspectRatio: bounds.width / bounds.height,
    fillDensity: visiblePixelWeight / (bounds.width * bounds.height),
    bounds
  };
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'Anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load sprite: ${url}`));
    image.src = url;
  });
}

function formatName(name) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// A small worker pool avoids starting 151 image requests at the same instant.
export async function loadPokemonDataset(onProgress = () => {}) {
  const response = await fetch(INDEX_URL);
  if (!response.ok) throw new Error(`PokéAPI returned HTTP ${response.status}`);
  const payload = await response.json();
  const species = payload.results.slice(0, 151);
  const dataset = new Array(species.length);
  let completed = 0;
  let successful = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < species.length) {
      const index = nextIndex;
      nextIndex += 1;
      const id = index + 1;
      const spriteUrl = `${SPRITE_URL}/${id}.png`;

      try {
        const image = await loadImage(spriteUrl);
        const sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = image.naturalWidth;
        sourceCanvas.height = image.naturalHeight;
        const context = sourceCanvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const fingerprint = createVisualFingerprint(sourceCanvas);
        if (fingerprint) {
          dataset[index] = {
            id,
            name: formatName(species[index].name),
            spriteUrl,
            fingerprint
          };
          successful += 1;
        }
      } catch (error) {
        console.warn(`Skipping Pokémon #${id}:`, error);
      }

      completed += 1;
      onProgress({ completed, total: species.length, successful });
    }
  }

  const workerCount = Math.min(10, species.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return dataset.filter(Boolean);
}