import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SeamSpectrumResult } from '../audio/seamSpectrum';
import { SPECTRUM_MAX_WINDOW_MS, SPECTRUM_MIN_WINDOW_MS } from '../audio/seamSpectrum';
import { fmtHz } from '../utils/format';

interface Props {
  /** 当前选中候选的频谱诊断结果 */
  spectrum: SeamSpectrumResult;
  /** 请求的检查窗时长（ms） */
  windowMs: number;
  setWindowMs: (v: number) => void;
  /** 头部片段起点相对源文件的时间（秒） */
  headStartSec: number;
  /** 尾部片段起点相对源文件的时间（秒） */
  tailStartSec: number;
  candidateRank: number;
}

const HEATMAP_H = 220;
const AXIS_H = 22;
const LABEL_W = 92;
const COLORBAR_W = 14;
const SCALE_W = 20;
const GAPS_W = 8 * 2 + 2; // 两个 8px gap + 余量

interface View {
  /** 可视范围：首帧（浮点） */
  startFrame: number;
  /** 可视帧数 */
  visibleFrames: number;
}

interface Tip {
  x: number;
  y: number;
  frame: number;
  band: number;
}

/** 差值（dB）→ 热力色：0 深青蓝 → 中段紫 → 高值暖黄 */
function diffColor(d: number, scale: number): string {
  const t = Math.max(0, Math.min(1, d / scale));
  const stops: Array<[number, number, number]> = [
    [13, 24, 48], // 近黑蓝
    [38, 70, 130], // 蓝
    [120, 58, 150], // 紫
    [214, 74, 92], // 红
    [255, 200, 87], // 暖黄
  ];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const [r1, g1, b1] = stops[i];
  const [r2, g2, b2] = stops[i + 1];
  const r = Math.round(r1 + (r2 - r1) * f);
  const g = Math.round(g1 + (g2 - g1) * f);
  const b = Math.round(b1 + (b2 - b1) * f);
  return `rgb(${r},${g},${b})`;
}

export function SeamSpectrumPanel({
  spectrum,
  windowMs,
  setWindowMs,
  headStartSec,
  tailStartSec,
  candidateRank,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const colorbarRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [cssWidth, setCssWidth] = useState(640);
  const [tip, setTip] = useState<Tip | null>(null);
  const [view, setView] = useState<View>({ startFrame: 0, visibleFrames: Math.max(1, spectrum.frameCount) });

  // 拖拽平移状态（记录在 ref，避免每个 pointermove 触发整组件重渲染）
  const dragRef = useRef<{ x: number; startFrame: number; visible: number } | null>(null);

  const plotW = Math.max(160, cssWidth - LABEL_W - COLORBAR_W - SCALE_W - GAPS_W - 16);

  // 候选/参数变化导致帧数变化时重置缩放
  const frameCount = spectrum.frameCount;
  const fcRef = useRef(frameCount);
  useEffect(() => {
    if (fcRef.current !== frameCount) {
      fcRef.current = frameCount;
      setView({ startFrame: 0, visibleFrames: frameCount });
    }
  }, [frameCount]);

  // 监听容器宽度（响应式 / 面板展开）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setCssWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clampView = useCallback(
    (v: View): View => {
      const visible = Math.max(1, Math.min(v.visibleFrames, frameCount));
      let start = v.startFrame;
      if (start < 0) start = 0;
      if (start + visible > frameCount) start = frameCount - visible;
      return { startFrame: start, visibleFrames: visible };
    },
    [frameCount],
  );

  const colorScale = useMemo(
    () => Math.max(6, Math.ceil(spectrum.maxDiffDb)),
    [spectrum.maxDiffDb],
  );

  // ---- 绘制热图 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = plotW;
    const h = HEATMAP_H + AXIS_H;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const nB = spectrum.bands.length;
    const bandH = HEATMAP_H / nB;
    const frameW = w / view.visibleFrames;
    const first = Math.max(0, Math.floor(view.startFrame));
    const last = Math.min(frameCount - 1, Math.ceil(view.startFrame + view.visibleFrames));

    for (let f = first; f <= last; f++) {
      const x = (f - view.startFrame) * frameW;
      for (let b = 0; b < nB; b++) {
        // 频带 0 在底部
        const y = HEATMAP_H - (b + 1) * bandH;
        ctx.fillStyle = diffColor(spectrum.diffDb[f][b], colorScale);
        ctx.fillRect(x, y, Math.ceil(frameW) + 1, Math.ceil(bandH) + 1);
      }
    }

    // 网格：帧分隔线（帧数不多时）
    if (view.visibleFrames <= 32) {
      ctx.strokeStyle = 'rgba(8,12,22,0.55)';
      ctx.lineWidth = 1;
      for (let f = first; f <= last + 1; f++) {
        const x = Math.round((f - view.startFrame) * frameW) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, HEATMAP_H);
        ctx.stroke();
      }
    }
    // 网格：频带分隔线
    ctx.strokeStyle = 'rgba(8,12,22,0.85)';
    for (let b = 1; b < nB; b++) {
      const y = Math.round(HEATMAP_H - b * bandH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // 时间轴刻度（帧中心相对片段起点的时间）
    ctx.fillStyle = '#9aa7bd';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const targetSpacing = 64;
    const step = Math.max(1, Math.ceil((targetSpacing / w) * view.visibleFrames));
    ctx.strokeStyle = '#232c40';
    ctx.beginPath();
    ctx.moveTo(0, HEATMAP_H + 0.5);
    ctx.lineTo(w, HEATMAP_H + 0.5);
    ctx.stroke();
    for (let f = first; f <= last; f += step) {
      const x = (f - view.startFrame + 0.5) * frameW;
      const t = spectrum.frameTimesSec[f] * 1000;
      const label = t >= 1000 ? `${(t / 1000).toFixed(2)}s` : `${t.toFixed(0)}ms`;
      ctx.fillText(label, Math.min(x + 3, w - 46), HEATMAP_H + 6);
      ctx.strokeStyle = 'rgba(154,167,189,0.35)';
      ctx.beginPath();
      ctx.moveTo(x, HEATMAP_H);
      ctx.lineTo(x, HEATMAP_H + 4);
      ctx.stroke();
    }
  }, [spectrum, view, plotW, frameCount, colorScale]);

  // ---- 绘制色条 ----
  useEffect(() => {
    const el = colorbarRef.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = COLORBAR_W * dpr;
    el.height = HEATMAP_H * dpr;
    el.style.width = `${COLORBAR_W}px`;
    el.style.height = `${HEATMAP_H}px`;
    const c = el.getContext('2d');
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let y = 0; y < HEATMAP_H; y++) {
      const d = ((HEATMAP_H - 1 - y) / (HEATMAP_H - 1)) * colorScale;
      c.fillStyle = diffColor(d, colorScale);
      c.fillRect(0, y, COLORBAR_W, 1);
    }
  }, [colorScale]);

  // ---- 滚轮缩放（以光标为中心）----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const frac = Math.max(0, Math.min(1, mx / plotW));
      setView((prev) => {
        const anchor = prev.startFrame + frac * prev.visibleFrames;
        const factor = e.deltaY < 0 ? 1 / 1.25 : 1.25;
        const visible = Math.max(1, Math.min(frameCount, prev.visibleFrames * factor));
        return clampView({ startFrame: anchor - frac * visible, visibleFrames: visible });
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [plotW, frameCount, clampView]);

  const pickCell = useCallback(
    (clientX: number, clientY: number): Tip | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (x < 0 || x >= plotW || y < 0 || y >= HEATMAP_H) return null;
      const f = Math.floor(view.startFrame + (x / plotW) * view.visibleFrames);
      if (f < 0 || f >= frameCount) return null;
      const nB = spectrum.bands.length;
      const band = Math.min(nB - 1, Math.max(0, nB - 1 - Math.floor(y / (HEATMAP_H / nB))));
      return { x, y, frame: f, band };
    },
    [plotW, view, frameCount, spectrum.bands.length],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, startFrame: view.startFrame, visible: view.visibleFrames };
    setTip(null);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.x;
      const dFrame = (-dx / plotW) * dragRef.current.visible;
      setView(clampView({ startFrame: dragRef.current.startFrame + dFrame, visibleFrames: dragRef.current.visible }));
      return;
    }
    setTip(pickCell(e.clientX, e.clientY));
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
    }
  };

  const zoomBy = (factor: number) => {
    setView((prev) => {
      const anchor = prev.startFrame + prev.visibleFrames / 2;
      const visible = Math.max(1, Math.min(frameCount, prev.visibleFrames * factor));
      return clampView({ startFrame: anchor - visible / 2, visibleFrames: visible });
    });
  };

  const resetView = () => setView({ startFrame: 0, visibleFrames: frameCount });

  const worst = spectrum.bands[spectrum.worstBand];
  const peak = spectrum.bands[spectrum.maxDiffBand];
  const effectiveMs = Math.round(spectrum.windowMs);

  return (
    <section className="panel spectrum-panel">
      <h2>接缝频谱检查（候选 #{candidateRank}）</h2>
      <p className="spectrum-desc">
        对循环头部与尾部各取相同长度片段，按 50% 重叠 Hann 窗做 STFT，
        逐帧比较 8 个对数频带的能量差（dB）。切换候选或调整交叉淡化会实时重算。
      </p>

      <div className="spectrum-controls">
        <label className="spectrum-slider">
          <span>检查窗：<b>{effectiveMs} ms</b>{spectrum.clamped && <em className="stale">（已夹取）</em>}</span>
          <input
            type="range"
            min={SPECTRUM_MIN_WINDOW_MS}
            max={SPECTRUM_MAX_WINDOW_MS}
            step={10}
            value={Math.min(windowMs, SPECTRUM_MAX_WINDOW_MS)}
            onChange={(e) => setWindowMs(Number(e.target.value))}
          />
        </label>
        <div className="spectrum-summary">
          <span className="chip chip-max">
            最大差值 <b>{spectrum.maxDiffDb.toFixed(1)} dB</b>
            <em>
              帧 {spectrum.maxDiffFrame + 1}/{frameCount} · {fmtHz(peak.lowHz)}–{fmtHz(peak.highHz)}
            </em>
          </span>
          <span className="chip chip-worst">
            最差频带 <b>{fmtHz(worst.lowHz)}–{fmtHz(worst.highHz)}</b>
            <em>平均差 {spectrum.worstBandMeanDiffDb.toFixed(1)} dB · 峰值 {spectrum.bandMaxDiffDb[spectrum.worstBand].toFixed(1)} dB</em>
          </span>
        </div>
      </div>

      {spectrum.clamped && (
        <p className="spectrum-warning">
          ⚠ 请求的 {windowMs} ms 检查窗超过循环时长的一半，已自动夹取为 {effectiveMs} ms
          （头部与尾部片段长度相同且不得重叠）。
        </p>
      )}

      <div className="spectrum-meta">
        FFT {spectrum.fftSize} 点 · Hop {spectrum.hopSamples} 采样（50%）· Hann 窗 · {frameCount} 帧 × 8 频带 ·{' '}
        能量地板 −120 dBFS（静音频带安全兜底，无 NaN/Infinity）
      </div>

      <div className="heatmap-wrap" ref={wrapRef}>
        <div className="band-labels" style={{ height: HEATMAP_H }}>
          {spectrum.bands.map((b, i) => (
            <div
              key={i}
              className={`band-label${i === spectrum.worstBand ? ' worst' : ''}`}
              style={{ height: `${100 / spectrum.bands.length}%` }}
            >
              {fmtHz(b.lowHz)}–{fmtHz(b.highHz)}
            </div>
          ))}
        </div>
        <div className="heatmap-area">
          <canvas
            ref={canvasRef}
            className="heatmap-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => {
              dragRef.current = null;
              setTip(null);
            }}
            onDoubleClick={resetView}
          />
          {tip && (
            <div
              className="heatmap-tip"
              style={{
                left: Math.min(tip.x + 14, plotW - 190),
                top: Math.max(4, tip.y - 10),
              }}
            >
              <b>帧 {tip.frame + 1}/{frameCount}</b>（t = {(spectrum.frameTimesSec[tip.frame] * 1000).toFixed(1)} ms）
              <span className="tip-band">{fmtHz(spectrum.bands[tip.band].lowHz)}–{fmtHz(spectrum.bands[tip.band].highHz)}</span>
              <span>头 {spectrum.headDb[tip.frame][tip.band].toFixed(1)} dB · 尾 {spectrum.tailDb[tip.frame][tip.band].toFixed(1)} dB</span>
              <span className="tip-diff">差值 {spectrum.diffDb[tip.frame][tip.band].toFixed(2)} dB</span>
            </div>
          )}
        </div>
        <div className="colorbar-col">
          <div className="colorbar" style={{ height: HEATMAP_H }}>
            <canvas ref={colorbarRef} />
          </div>
        </div>
        <div className="colorbar-scale" style={{ height: HEATMAP_H }}>
          <span>{colorScale}</span>
          <span>{Math.round(colorScale / 2)}</span>
          <span>0</span>
        </div>
      </div>

      <div className="heatmap-toolbar">
        <button type="button" onClick={() => zoomBy(1 / 1.5)}>＋ 放大</button>
        <button type="button" onClick={() => zoomBy(1.5)}>－ 缩小</button>
        <button type="button" onClick={resetView}>复位</button>
        <span className="heatmap-hint">滚轮缩放 · 拖拽平移 · 双击复位 · 悬停查看 dB 数值</span>
      </div>

      <p className="spectrum-segments">
        头部片段：{headStartSec.toFixed(3)}s 起 · 尾部片段：{tailStartSec.toFixed(3)}s 起（均长 {effectiveMs} ms，
        取自含交叉淡化的实际循环缓冲）
      </p>
    </section>
  );
}
