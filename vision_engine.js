import { COLOR_BUCKETS, createVisualFingerprint } from './pokemon_data.js';

const OCCUPIED_ALPHA = 0.12;

function histogramSimilarity(left, right) {
  // Both histograms add up to 1. Adding the smaller share in each bucket gives
  // their overlap: 1 means the same color mix, while 0 means no shared colors.
  let overlap = 0;
  for (let index = 0; index < COLOR_BUCKETS.length; index += 1) {
    overlap += Math.min(left[index], right[index]);
  }
  return overlap;
}

function spatialSimilarity(leftGrid, rightGrid) {
  let cellScore = 0;

  for (let index = 0; index < leftGrid.length; index += 1) {
    const left = leftGrid[index];
    const right = rightGrid[index];
    const leftFilled = left.a >= OCCUPIED_ALPHA;
    const rightFilled = right.a >= OCCUPIED_ALPHA;

    if (leftFilled && rightFilled) {
      // Euclidean RGB distance is at most sqrt(3 * 255^2). Dividing by that
      // maximum turns the distance into a 0..1 similarity for this grid cell.
      const redDistance = left.r - right.r;
      const greenDistance = left.g - right.g;
      const blueDistance = left.b - right.b;
      const rgbDistance = Math.sqrt(redDistance ** 2 + greenDistance ** 2 + blueDistance ** 2);
      cellScore += 1 - rgbDistance / Math.sqrt(3 * 255 ** 2);
    } else if (!leftFilled && !rightFilled) {
      // Matching empty space is a weak signal; it should not outweigh the drawing.
      cellScore += 0.15;
    }
  }

  return cellScore / leftGrid.length;
}

function shapeSimilarity(left, right) {
  // Intersection-over-union compares occupied cells without rewarding a large
  // empty background: shared filled cells / cells filled by either drawing.
  let intersection = 0;
  let union = 0;

  for (let index = 0; index < left.grid.length; index += 1) {
    const leftFilled = left.grid[index].a >= OCCUPIED_ALPHA;
    const rightFilled = right.grid[index].a >= OCCUPIED_ALPHA;
    if (leftFilled || rightFilled) union += 1;
    if (leftFilled && rightFilled) intersection += 1;
  }

  const silhouetteOverlap = union === 0 ? 0 : intersection / union;
  // The logarithm makes reciprocal ratio differences symmetric (2:1 vs 1:1
  // is penalized like 1:2 vs 1:1); the exponential maps that penalty to 0..1.
  const aspectSimilarity = Math.exp(-Math.abs(Math.log(left.aspectRatio / right.aspectRatio)));
  const densitySimilarity = Math.max(0, 1 - Math.abs(left.fillDensity - right.fillDensity));
  // IoU carries most of the shape score; aspect and density refine it.
  return silhouetteOverlap * 0.65 + aspectSimilarity * 0.2 + densitySimilarity * 0.15;
}

function updatePreview(previewCanvas, fingerprint) {
  const context = previewCanvas.getContext('2d');
  const pixels = context.createImageData(16, 16);

  fingerprint.grid.forEach((cell, index) => {
    const offset = index * 4;
    pixels.data[offset] = cell.r;
    pixels.data[offset + 1] = cell.g;
    pixels.data[offset + 2] = cell.b;
    pixels.data[offset + 3] = Math.round(cell.a * 255);
  });
  context.putImageData(pixels, 0, 0);
}

// Returns the five highest visual similarities. The percentage is a weighted
// feature score, not a statistical probability from a trained recognition model.
export function predictPokemon(userCanvas, previewCanvas, pokemonDataset) {
  const userFingerprint = createVisualFingerprint(userCanvas);
  if (!userFingerprint) return null;

  updatePreview(previewCanvas, userFingerprint);
  const ranked = pokemonDataset.map((pokemon) => {
    const reference = pokemon.fingerprint;
    const colorScore = histogramSimilarity(userFingerprint.histogram, reference.histogram);
    const spatialScore = spatialSimilarity(userFingerprint.grid, reference.grid);
    const silhouetteScore = shapeSimilarity(userFingerprint, reference);
    // Keep the requested priorities visible here: palette first, then layout,
    // then the broader silhouette measurements.
    const score = colorScore * 0.5 + spatialScore * 0.3 + silhouetteScore * 0.2;

    return { ...pokemon, score, confidence: Math.round(score * 100) };
  });

  ranked.sort((left, right) => right.score - left.score || left.id - right.id);
  return {
    matches: ranked.slice(0, 5),
    fingerprint: userFingerprint
  };
}