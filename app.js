import { COLOR_BUCKETS, colorBucketIndex, loadPokemonDataset } from './pokemon_data.js';
import { predictPokemon } from './vision_engine.js';

const canvas = document.querySelector('#drawing-canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });
const previewCanvas = document.querySelector('#preview-canvas');
const palette = document.querySelector('#palette');
const brushSize = document.querySelector('#brush-size');
const brushValue = document.querySelector('#brush-value');
const eraserToggle = document.querySelector('#eraser-toggle');
const undoButton = document.querySelector('#undo-button');
const clearButton = document.querySelector('#clear-button');
const colorPicker = document.querySelector('#custom-color');
const activeColorName = document.querySelector('#active-color-name');
const leaderboard = document.querySelector('#leaderboard');
const predictionRows = [...leaderboard.querySelectorAll('.prediction-row')];
const indexStatus = document.querySelector('#index-status');
const statusLight = document.querySelector('#status-light');
const spriteProgress = document.querySelector('#sprite-progress');
const spriteCount = document.querySelector('#sprite-count');
const loadMessage = document.querySelector('#load-message');
const scanCounter = document.querySelector('#scan-counter');
const aspectReadout = document.querySelector('#aspect-readout');
const fillReadout = document.querySelector('#fill-readout');
const colorReadout = document.querySelector('#color-readout');

const MAX_UNDO_STEPS = 30;
const PREDICTION_INTERVAL = 150;
const undoHistory = [];
let pokemonDataset = [];
let isDrawing = false;
let isEraserOn = false;
let activeColor = '#f6cf32';
let lastPoint = null;
let lastPredictionTime = 0;
let predictionTimer = null;

function setSelectedColor(button, color, name) {
  activeColor = color;
  activeColorName.textContent = name;
  palette.querySelectorAll('.swatch').forEach((swatch) => {
    const selected = swatch === button;
    swatch.classList.toggle('is-selected', selected);
    swatch.setAttribute('aria-pressed', String(selected));
  });
  eraserToggle.setAttribute('aria-pressed', 'false');
  isEraserOn = false;
}

palette.addEventListener('click', (event) => {
  const swatch = event.target.closest('.swatch');
  if (!swatch) return;
  setSelectedColor(swatch, swatch.dataset.color, swatch.dataset.name);
  colorPicker.value = swatch.dataset.color;
});

colorPicker.addEventListener('input', () => {
  palette.querySelectorAll('.swatch').forEach((swatch) => {
    swatch.classList.remove('is-selected');
    swatch.setAttribute('aria-pressed', 'false');
  });
  activeColor = colorPicker.value;
  activeColorName.textContent = 'Custom color';
  isEraserOn = false;
  eraserToggle.setAttribute('aria-pressed', 'false');
});

brushSize.addEventListener('input', () => {
  brushValue.value = `${brushSize.value} px`;
  brushValue.textContent = `${brushSize.value} px`;
});

eraserToggle.addEventListener('click', () => {
  isEraserOn = !isEraserOn;
  eraserToggle.setAttribute('aria-pressed', String(isEraserOn));
});

function canvasPoint(event) {
  const rectangle = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rectangle.left) * (canvas.width / rectangle.width),
    y: (event.clientY - rectangle.top) * (canvas.height / rectangle.height)
  };
}

function saveUndoStep() {
  undoHistory.push(context.getImageData(0, 0, canvas.width, canvas.height));
  if (undoHistory.length > MAX_UNDO_STEPS) undoHistory.shift();
  undoButton.disabled = false;
}

function configureBrush() {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = Number(brushSize.value);
  context.globalCompositeOperation = isEraserOn ? 'destination-out' : 'source-over';
  context.strokeStyle = activeColor;
  context.fillStyle = activeColor;
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  saveUndoStep();
  isDrawing = true;
  lastPoint = canvasPoint(event);
  canvas.setPointerCapture(event.pointerId);
  configureBrush();

  // A short round stroke makes a tap leave a visible dot.
  context.beginPath();
  context.arc(lastPoint.x, lastPoint.y, Number(brushSize.value) / 2, 0, Math.PI * 2);
  context.fill();
  schedulePrediction(true);
});

canvas.addEventListener('pointermove', (event) => {
  if (!isDrawing || !lastPoint) return;
  event.preventDefault();
  const point = canvasPoint(event);
  configureBrush();
  context.beginPath();
  context.moveTo(lastPoint.x, lastPoint.y);
  context.lineTo(point.x, point.y);
  context.stroke();
  lastPoint = point;
  schedulePrediction(false);
});

function finishStroke(event) {
  if (!isDrawing) return;
  isDrawing = false;
  lastPoint = null;
  if (event && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  context.globalCompositeOperation = 'source-over';
  schedulePrediction(true);
}

canvas.addEventListener('pointerup', finishStroke);
canvas.addEventListener('pointercancel', finishStroke);
canvas.addEventListener('lostpointercapture', finishStroke);

undoButton.addEventListener('click', () => {
  const previousImage = undoHistory.pop();
  if (!previousImage) return;
  context.globalCompositeOperation = 'source-over';
  context.putImageData(previousImage, 0, 0);
  undoButton.disabled = undoHistory.length === 0;
  schedulePrediction(true);
});

clearButton.addEventListener('click', () => {
  isDrawing = false;
  lastPoint = null;
  context.globalCompositeOperation = 'source-over';
  context.clearRect(0, 0, canvas.width, canvas.height);
  undoHistory.length = 0;
  undoButton.disabled = true;
  const previewContext = previewCanvas.getContext('2d');
  previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  aspectReadout.textContent = '--';
  fillReadout.textContent = '--';
  colorReadout.textContent = '--';
  showWaitingRows();
  schedulePrediction(true);
});

function showWaitingRows() {
  const previewContext = previewCanvas.getContext('2d');
  previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  aspectReadout.textContent = '--';
  fillReadout.textContent = '--';
  colorReadout.textContent = '--';

  predictionRows.forEach((row, index) => {
    row.classList.add('is-empty');
    row.querySelector('.rank').textContent = String(index + 1).padStart(2, '0');
    const oldImage = row.querySelector('.pokemon-sprite');
    if (oldImage) oldImage.remove();
    let placeholder = row.querySelector('.sprite-placeholder');
    if (!placeholder) {
      placeholder = document.createElement('span');
      placeholder.className = 'sprite-placeholder';
      placeholder.textContent = '?';
      row.insertBefore(placeholder, row.querySelector('.prediction-info'));
    }
    row.querySelector('.pokemon-name').textContent = index === 0 ? 'Waiting for a sketch' : 'Add a few marks to scan';
    const scoreTrack = row.querySelector('.score-track');
    scoreTrack.querySelector('.score-fill').style.width = '0%';
    scoreTrack.removeAttribute('role');
    scoreTrack.removeAttribute('aria-label');
    scoreTrack.removeAttribute('aria-valuemin');
    scoreTrack.removeAttribute('aria-valuemax');
    scoreTrack.removeAttribute('aria-valuenow');
    row.querySelector('.confidence').textContent = '--%';
  });
  scanCounter.textContent = 'WAITING';
}

function renderPredictions(result) {
  result.matches.forEach((pokemon, index) => {
    const row = predictionRows[index];
    row.classList.remove('is-empty');
    row.querySelector('.rank').textContent = String(index + 1).padStart(2, '0');

    let image = row.querySelector('.pokemon-sprite');
    if (!image) {
      image = document.createElement('img');
      image.className = 'pokemon-sprite';
      image.alt = '';
      image.loading = 'eager';
      const placeholder = row.querySelector('.sprite-placeholder');
      if (placeholder) placeholder.replaceWith(image);
      else row.insertBefore(image, row.querySelector('.prediction-info'));
    }
    if (image.src !== pokemon.spriteUrl) image.src = pokemon.spriteUrl;
    row.querySelector('.pokemon-name').textContent = pokemon.name;
    const scoreFill = row.querySelector('.score-fill');
    scoreFill.style.width = `${pokemon.confidence}%`;
    row.querySelector('.confidence').textContent = `${pokemon.confidence}%`;
    scoreFill.parentElement.setAttribute('role', 'progressbar');
    scoreFill.parentElement.setAttribute('aria-label', `${pokemon.name} visual similarity`);
    scoreFill.parentElement.setAttribute('aria-valuemin', '0');
    scoreFill.parentElement.setAttribute('aria-valuemax', '100');
    scoreFill.parentElement.setAttribute('aria-valuenow', String(pokemon.confidence));
  });

  const fingerprint = result.fingerprint;
  aspectReadout.textContent = `${fingerprint.aspectRatio.toFixed(2)}:1`;
  fillReadout.textContent = `${Math.round(fingerprint.fillDensity * 100)}%`;
  const dominantBucket = fingerprint.histogram.indexOf(Math.max(...fingerprint.histogram));
  colorReadout.textContent = COLOR_BUCKETS[dominantBucket];
  scanCounter.textContent = `${result.matches.length} MATCHES`;
}

function runPrediction() {
  predictionTimer = null;
  if (!pokemonDataset.length) return;
  const result = predictPokemon(canvas, previewCanvas, pokemonDataset);
  if (!result) {
    showWaitingRows();
    return;
  }
  renderPredictions(result);
}

// Keep the expensive canvas scan to roughly one run per 150 ms while drawing.
function schedulePrediction(force) {
  if (!pokemonDataset.length) return;
  const now = performance.now();
  const delay = force ? 0 : Math.max(0, PREDICTION_INTERVAL - (now - lastPredictionTime));
  if (predictionTimer !== null) {
    if (!force) return;
    clearTimeout(predictionTimer);
  }
  predictionTimer = window.setTimeout(() => {
    lastPredictionTime = performance.now();
    runPrediction();
  }, delay);
}

loadPokemonDataset(({ completed, total, successful }) => {
  spriteProgress.max = total;
  spriteProgress.value = completed;
  spriteCount.textContent = `${successful} / ${total}`;
  loadMessage.textContent = `Preparing sprite fingerprints: ${completed} of ${total}`;
}).then((dataset) => {
  pokemonDataset = dataset;
  statusLight.classList.add('is-ready');
  indexStatus.textContent = `Sprite index ready · ${dataset.length} Pokémon`;
  loadMessage.textContent = dataset.length === 151
    ? 'All 151 Gen 1 sprites are ready for matching.'
    : `${dataset.length} of 151 sprites loaded. Unavailable sprites are skipped.`;
  schedulePrediction(true);
}).catch((error) => {
  console.error('Unable to build the sprite index:', error);
  statusLight.classList.add('is-error');
  indexStatus.textContent = 'Sprite index unavailable';
  loadMessage.textContent = 'Could not load PokéAPI or sprite images. Check your connection and reload.';
  scanCounter.textContent = 'OFFLINE';
});