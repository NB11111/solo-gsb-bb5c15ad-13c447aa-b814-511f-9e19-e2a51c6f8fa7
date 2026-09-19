import type { AudioDataLike } from './types';
import { buildLoopPcm } from './loopBuffer';

/**
 * 接缝频谱检查：对「实际播放/导出的循环 PCM」（buildLoopPcm，含交叉淡化）
 * 的头部与尾部各取相同长度片段，用 50% 重叠的 Hann 窗做 STFT，
 * 将对应时间帧在 8 个对数频带上的能量差（dB）组成热图，
 * 用于判断回绕处在频谱上是否连续（仅有波形代价无法察觉的音色断层）。
 */

export const SPECTRUM_BAND_COUNT = 8;
export const SPECTRUM_MIN_WINDOW_MS = 50;
export const SPECTRUM_MAX_WINDOW_MS = 500;
const FFT_MAX = 2048;
const FFT_MIN = 64;
/**
 * 静音频带的能量地板（dBFS）：能量按此地板兜底，
 * 保证静音段不会出现 log(0) = -Infinity，差值也不会产生 NaN/Infinity。
 */
export const SPECTRUM_NOISE_FLOOR_DB = -120;
const POWER_FLOOR = Math.pow(10, SPECTRUM_NOISE_FLOOR_DB / 10);

export interface SeamSpectrumBand {
  /** 频带实际下沿（Hz，按 FFT 仓对齐） */
  lowHz: number;
  /** 频带实际上沿（Hz） */
  highHz: number;
}

export interface SeamSpectrumResult {
  /** 用户请求的检查窗时长（ms） */
  requestedWindowMs: number;
  /** 实际使用的检查窗时长（ms，夹取后可能小于请求值） */
  windowMs: number;
  /** 实际检查窗长度（采样点） */
  windowSamples: number;
  /** 请求窗超过循环一半，被自动夹取 */
  clamped: boolean;
  /** 循环长度（采样点） */
  loopSamples: number;
  fftSize: number;
  hopSamples: number;
  /** 每个片段参与对比的 STFT 帧数（头/尾相同） */
  frameCount: number;
  bands: SeamSpectrumBand[];
  /** 各帧中心相对片段起点的时间（秒） */
  frameTimesSec: number[];
  /** [帧][频带] 头部片段能量（dBFS） */
  headDb: number[][];
  /** [帧][频带] 尾部片段能量（dBFS） */
  tailDb: number[][];
  /** [帧][频带] |尾 − 头| 能量差（dB） */
  diffDb: number[][];
  /** 全图最大差值（dB） */
  maxDiffDb: number;
  maxDiffFrame: number;
  maxDiffBand: number;
  /** 各频带在所有帧上的最大差值（dB） */
  bandMaxDiffDb: number[];
  /** 各频带在所有帧上的平均差值（dB） */
  bandMeanDiffDb: number[];
  /** 平均差值最大的频带编号（0 起） */
  worstBand: number;
  worstBandMeanDiffDb: number;
}

/** 不大于 v 的最大 2 的幂（上限 cap） */
function largestPow2Below(v: number, cap: number): number {
  let p = 1;
  while (p * 2 <= v && p < cap) p *= 2;
  return p;
}

/**
 * 选择 FFT 长度：优先取 ≤ W/4 的最大 2 的幂（保证至少 ~7 帧、50% 重叠），
 * 窗口实在太短时退而取 ≤ W/2；上限 2048，下限由帧计数兜底。
 */
function chooseFftSize(windowSamples: number): number {
  let fft = largestPow2Below(Math.floor(windowSamples / 4), FFT_MAX);
  if (fft < FFT_MIN) fft = largestPow2Below(Math.floor(windowSamples / 2), FFT_MAX);
  return Math.max(2, fft);
}

/** 原地基-2 迭代 FFT（n 必须为 2 的幂） */
function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wpr = Math.cos(ang);
    const wpi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < half; j++) {
        const idx = i + j + half;
        const ur = re[idx] * wr - im[idx] * wi;
        const ui = re[idx] * wi + im[idx] * wr;
        re[idx] = re[i + j] - ur;
        im[idx] = im[i + j] - ui;
        re[i + j] += ur;
        im[i + j] += ui;
        const nwr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = nwr;
      }
    }
  }
}

interface BinRange {
  startBin: number;
  endBin: number; // 不含
}

/**
 * 8 个几何等距（对数）频带：下沿取 max(20 Hz, 1 个 FFT 仓宽) 并跳过 DC，
 * 上沿为 Nyquist；按仓边界映射并强制每带至少 1 个仓、单调不重叠。
 */
function buildBands(fftSize: number, sampleRate: number): { bands: SeamSpectrumBand[]; ranges: BinRange[] } {
  const nBins = fftSize / 2 + 1;
  const binHz = sampleRate / fftSize;
  const lowFreq = Math.max(20, binHz);
  const highFreq = sampleRate / 2;
  const ratio = Math.pow(highFreq / lowFreq, 1 / SPECTRUM_BAND_COUNT);

  const bands: SeamSpectrumBand[] = [];
  const ranges: BinRange[] = [];
  let prevEnd = 1; // 跳过 DC（bin 0）
  for (let b = 0; b < SPECTRUM_BAND_COUNT; b++) {
    const startBin = Math.min(prevEnd, Math.max(1, nBins - 1));
    let endBin: number;
    if (b === SPECTRUM_BAND_COUNT - 1) {
      endBin = nBins; // 末带延伸到 Nyquist
    } else {
      endBin = Math.max(startBin + 1, Math.ceil((lowFreq * Math.pow(ratio, b + 1)) / binHz));
    }
    endBin = Math.min(endBin, nBins);
    if (endBin <= startBin) endBin = Math.min(startBin + 1, nBins);
    bands.push({ lowHz: startBin * binHz, highHz: endBin * binHz });
    ranges.push({ startBin, endBin });
    prevEnd = endBin;
  }
  return { bands, ranges };
}

/**
 * 对单个片段做多声道 STFT，返回 [帧][频带] 平均功率（多声道取均值，
 * 单边谱乘 2 并按 1/N² 归一化，量纲近似 dBFS；静音频带由调用方兜底）。
 */
function stftBandPower(
  segment: Float32Array[],
  segLen: number,
  fftSize: number,
  hopSamples: number,
  frameCount: number,
  window: Float64Array,
  ranges: BinRange[],
): number[][] {
  const nCh = segment.length;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const acc = new Float64Array(fftSize / 2 + 1);
  const rows: number[][] = [];

  for (let t = 0; t < frameCount; t++) {
    // 极端兜底（片段短于 FFT）：只取 1 帧、左侧对齐、窗内其余部分补零
    const f0 = frameCount === 1 ? 0 : t * hopSamples;
    acc.fill(0);
    for (let ch = 0; ch < nCh; ch++) {
      const x = segment[ch];
      re.fill(0);
      im.fill(0);
      const take = Math.min(fftSize, segLen - f0);
      for (let n = 0; n < take; n++) re[n] = x[f0 + n] * window[n];
      fftRadix2(re, im);
      for (let k = 0; k <= fftSize / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    }
    const row = new Array<number>(SPECTRUM_BAND_COUNT);
    for (let b = 0; b < SPECTRUM_BAND_COUNT; b++) {
      let sum = 0;
      const { startBin, endBin } = ranges[b];
      for (let k = startBin; k < endBin; k++) sum += acc[k];
      let p = (2 * sum) / (nCh * fftSize * fftSize);
      // 防御性有限性检查：任何非有限输入都不得污染结果
      if (!Number.isFinite(p)) p = 0;
      row[b] = p;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * 分析接缝两侧频谱差。
 *
 * @param audio        源音频（AudioBuffer 即可）
 * @param startSample  循环起点（采样点，含）
 * @param endSample    循环终点（采样点，不含）
 * @param crossfadeSamples 交叉淡化长度（采样点，与播放/导出一致，内部夹取）
 * @param requestedWindowMs 请求的检查窗时长（50–500 ms）
 */
export function analyzeSeamSpectrum(
  audio: AudioDataLike,
  startSample: number,
  endSample: number,
  crossfadeSamples: number,
  requestedWindowMs: number,
): SeamSpectrumResult {
  // 与播放 / WAV 导出完全相同的循环构造（含等功率交叉淡化），
  // 保证「检查的就是听到的、导出的」。
  const loop = buildLoopPcm(audio, startSample, endSample, crossfadeSamples);
  const L = loop.channels[0].length;
  const sr = audio.sampleRate;

  const requested = Math.max(1, Math.round((requestedWindowMs / 1000) * sr));
  const maxWindow = Math.max(2, Math.floor(L / 2));
  // 窗长超过循环一半时自动夹取（两段相同长度，不得重叠）
  const W = Math.min(requested, maxWindow);
  const clamped = W < requested;

  const fftSize = chooseFftSize(W);
  const hopSamples = fftSize / 2;
  const frameCount = Math.max(1, Math.floor((W - fftSize) / hopSamples) + 1);

  // 周期 Hann 窗：w[n] = 0.5(1 − cos(2πn/N))
  const window = new Float64Array(fftSize);
  for (let n = 0; n < fftSize; n++) window[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / fftSize));

  const { bands, ranges } = buildBands(fftSize, sr);

  const head: Float32Array[] = loop.channels.map((ch) => ch.subarray(0, W));
  const tailOffset = L - W;
  const tail: Float32Array[] = loop.channels.map((ch) => ch.subarray(tailOffset, L));

  const headPower = stftBandPower(head, W, fftSize, hopSamples, frameCount, window, ranges);
  const tailPower = stftBandPower(tail, W, fftSize, hopSamples, frameCount, window, ranges);

  const toDb = (p: number): number => {
    const db = 10 * Math.log10(Math.max(POWER_FLOOR, p));
    return Number.isFinite(db) ? Math.max(SPECTRUM_NOISE_FLOOR_DB, db) : SPECTRUM_NOISE_FLOOR_DB;
  };

  const headDb: number[][] = [];
  const tailDb: number[][] = [];
  const diffDb: number[][] = [];
  const frameTimesSec: number[] = [];
  const bandMax = new Array<number>(SPECTRUM_BAND_COUNT).fill(0);
  const bandSum = new Array<number>(SPECTRUM_BAND_COUNT).fill(0);
  let maxDiff = 0;
  let maxFrame = 0;
  let maxBand = 0;

  for (let t = 0; t < frameCount; t++) {
    const f0 = frameCount === 1 ? 0 : t * hopSamples;
    frameTimesSec.push((f0 + fftSize / 2) / sr);
    const hr: number[] = [];
    const tr: number[] = [];
    const dr: number[] = [];
    for (let b = 0; b < SPECTRUM_BAND_COUNT; b++) {
      const h = toDb(headPower[t][b]);
      const tl = toDb(tailPower[t][b]);
      const d = Math.abs(tl - h); // 两个 dB 均有限，差值必为有限值
      hr.push(h);
      tr.push(tl);
      dr.push(d);
      if (d > bandMax[b]) bandMax[b] = d;
      bandSum[b] += d;
      if (d > maxDiff) {
        maxDiff = d;
        maxFrame = t;
        maxBand = b;
      }
    }
    headDb.push(hr);
    tailDb.push(tr);
    diffDb.push(dr);
  }

  const bandMean = bandSum.map((s) => s / frameCount);
  let worstBand = 0;
  for (let b = 1; b < SPECTRUM_BAND_COUNT; b++) {
    if (bandMean[b] > bandMean[worstBand]) worstBand = b;
  }

  return {
    requestedWindowMs,
    windowMs: (W / sr) * 1000,
    windowSamples: W,
    clamped,
    loopSamples: L,
    fftSize,
    hopSamples,
    frameCount,
    bands,
    frameTimesSec,
    headDb,
    tailDb,
    diffDb,
    maxDiffDb: maxDiff,
    maxDiffFrame: maxFrame,
    maxDiffBand: maxBand,
    bandMaxDiffDb: bandMax,
    bandMeanDiffDb: bandMean,
    worstBand,
    worstBandMeanDiffDb: bandMean[worstBand],
  };
}
